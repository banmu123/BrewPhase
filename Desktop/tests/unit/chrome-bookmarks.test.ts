import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectChrome, parseChromeBookmarks, readChromeBookmarks } from '../../src/main/browser/chrome-bookmarks'

/**
 * Chrome 检测与解析的单元测试。
 *
 * 全部用临时目录里的模拟 Profile：不依赖开发机装没装 Chrome，也不会碰到
 * 任何真实用户数据。解析是纯函数，喂固定 JSON 就能覆盖层级、空文件夹、
 * 协议过滤与损坏文件。
 */

const ENV_KEY = 'BREWPHASE_CHROME_USER_DATA_DIR'
const ORIGINAL_ENV = process.env[ENV_KEY]

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bp-chrome-'))
  process.env[ENV_KEY] = root
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ORIGINAL_ENV
  rmSync(root, { recursive: true, force: true })
})

function writeProfile(id: string, bookmarks?: unknown): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  if (bookmarks !== undefined) {
    writeFileSync(join(dir, 'Bookmarks'), JSON.stringify(bookmarks))
  }
}

function writeLocalState(profiles: Record<string, string>): void {
  const infoCache = Object.fromEntries(Object.entries(profiles).map(([id, name]) => [id, { name }]))
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }))
}

const SAMPLE = {
  roots: {
    bookmark_bar: {
      type: 'folder',
      name: '书签栏',
      children: [
        { type: 'url', name: 'Example', url: 'https://example.com/', id: '11', guid: 'g-11' },
        {
          type: 'folder',
          name: '工具',
          id: '12',
          guid: 'g-12',
          children: [
            { type: 'url', name: '本地', url: 'http://127.0.0.1:8080/', id: '13', guid: 'g-13' }
          ]
        },
        { type: 'folder', name: '空文件夹', id: '14', guid: 'g-14', children: [] }
      ]
    },
    other: {
      type: 'folder',
      name: '其他书签',
      children: [
        { type: 'url', name: '脚本', url: 'javascript:alert(1)', id: '21', guid: 'g-21' },
        { type: 'url', name: '本地文件', url: 'file:///etc/passwd', id: '22', guid: 'g-22' },
        { type: 'url', name: 'Chrome 内部', url: 'chrome://settings', id: '23', guid: 'g-23' }
      ]
    },
    synced: {
      type: 'folder',
      name: '移动设备书签',
      children: [{ type: 'url', name: '手机', url: 'https://m.example.com/', id: '31', guid: 'g-31' }]
    }
  },
  version: 1
}

describe('detectChrome', () => {
  it('读到 Local State 里用户起的名字，并标出 Bookmarks 是否存在', () => {
    writeLocalState({ Default: '个人', 'Profile 1': '工作' })
    writeProfile('Default', SAMPLE)
    writeProfile('Profile 1')

    const detection = detectChrome()
    expect(detection.found).toBe(true)
    expect(detection.reason).toBeNull()
    expect(detection.profiles.map((profile) => profile.id)).toEqual(['Default', 'Profile 1'])
    expect(detection.profiles.map((profile) => profile.name)).toEqual(['个人', '工作'])
    expect(detection.profiles[0]?.bookmarksAvailable).toBe(true)
    expect(detection.profiles[1]?.bookmarksAvailable).toBe(false)
  })

  it('Default 排最前，其余按 Profile 数字升序', () => {
    writeLocalState({ 'Profile 2': '三', Default: '一', 'Profile 10': '四', 'Profile 1': '二' })
    for (const id of ['Profile 2', 'Default', 'Profile 10', 'Profile 1']) writeProfile(id, SAMPLE)

    expect(detectChrome().profiles.map((profile) => profile.id)).toEqual([
      'Default',
      'Profile 1',
      'Profile 2',
      'Profile 10'
    ])
  })

  it('Local State 缺失时降级扫描目录，名称退回目录名', () => {
    writeProfile('Default', SAMPLE)
    writeProfile('Profile 1', SAMPLE)

    const detection = detectChrome()
    expect(detection.found).toBe(true)
    expect(detection.profiles.map((profile) => profile.id)).toEqual(['Default', 'Profile 1'])
    expect(detection.profiles[0]?.name).toBe('Default')
  })

  it('Local State 结构异常时同样降级，不抛异常', () => {
    writeFileSync(join(root, 'Local State'), '{ not json')
    writeProfile('Default', SAMPLE)

    const detection = detectChrome()
    expect(detection.found).toBe(true)
    expect(detection.profiles[0]?.id).toBe('Default')
  })

  it('目录不存在时报告 not-installed', () => {
    process.env[ENV_KEY] = join(root, 'missing')
    const detection = detectChrome()
    expect(detection.found).toBe(false)
    expect(detection.reason).toBe('not-installed')
    expect(detection.profiles).toEqual([])
  })

  it('有目录但没有可用 Profile 时报告 no-profiles', () => {
    mkdirSync(join(root, 'NotAProfile'), { recursive: true })
    const detection = detectChrome()
    expect(detection.found).toBe(false)
    expect(detection.reason).toBe('no-profiles')
  })
})

describe('parseChromeBookmarks', () => {
  it('保留三个根、层级、顺序与空文件夹', () => {
    const parsed = parseChromeBookmarks(SAMPLE, 'Default', '个人')
    expect(parsed).not.toBeNull()
    if (!parsed) return

    expect(parsed.roots.map((item) => item.kind)).toEqual(['bookmark_bar', 'other', 'synced'])
    expect(parsed.roots[0]?.children).toHaveLength(3)
    expect(parsed.roots[0]?.children.map((child) => child.title)).toEqual(['Example', '工具', '空文件夹'])

    const tool = parsed.roots[0]?.children[1]
    expect(tool?.kind).toBe('folder')
    if (tool?.kind === 'folder') {
      expect(tool.children).toHaveLength(1)
      expect(tool.children[0]?.kind === 'bookmark' ? tool.children[0].url : '').toBe(
        'http://127.0.0.1:8080/'
      )
    }

    const empty = parsed.roots[0]?.children[2]
    expect(empty?.kind).toBe('folder')
    if (empty?.kind === 'folder') expect(empty.children).toEqual([])
    // 两个文件夹（工具、空文件夹）；根节点本身不算文件夹。
    expect(parsed.folders).toBe(2)
    expect(parsed.bookmarks).toBe(3)
  })

  it('只保留 http/https，其余计入 skipped', () => {
    const parsed = parseChromeBookmarks(SAMPLE, 'Default', '个人')
    expect(parsed?.skipped).toBe(3)
    expect(parsed?.bookmarks).toBe(3)
  })

  it('同步的移动设备书签也会被解析', () => {
    const parsed = parseChromeBookmarks(SAMPLE, 'Default', '个人')
    const synced = parsed?.roots.find((rootItem) => rootItem.kind === 'synced')
    expect(synced?.children).toHaveLength(1)
    expect(synced?.children[0]?.title).toBe('手机')
  })

  it('节点 ID 优先 guid，其次 Chrome id，最后哈希兜底且稳定', () => {
    const json = {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '书签栏',
          children: [
            { type: 'url', name: '有 GUID', url: 'https://a.example/', guid: 'guid-a' },
            { type: 'url', name: '只有 ID', url: 'https://b.example/', id: '77' },
            { type: 'url', name: '都没有', url: 'https://c.example/', name2: '' }
          ]
        }
      }
    }
    const first = parseChromeBookmarks(json, 'Default', '个人')
    const second = parseChromeBookmarks(json, 'Default', '个人')
    const ids = first?.roots[0]?.children.map((child) => child.id) ?? []

    expect(ids[0]).toBe('chrome:Default:g:guid-a')
    expect(ids[1]).toBe('chrome:Default:i:77')
    expect(ids[2]?.startsWith('chrome:Default:h:')).toBe(true)
    // 同一份输入两次解析必须得到同一组 ID，否则重复导入会无限新增。
    expect(second?.roots[0]?.children.map((child) => child.id)).toEqual(ids)
  })

  it('同名同址且无 id 的重复书签用序号区分', () => {
    const json = {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '书签栏',
          children: [
            { type: 'url', name: '重复', url: 'https://dup.example/' },
            { type: 'url', name: '重复', url: 'https://dup.example/' }
          ]
        }
      }
    }
    const ids = parseChromeBookmarks(json, 'Default', '个人')?.roots[0]?.children.map((child) => child.id) ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('date_added 从 Chrome 的微秒时间轴换算成毫秒', () => {
    const created = Date.UTC(2024, 0, 2, 3, 4, 5)
    const chromeMicros = String((created + 11_644_473_600_000) * 1000)
    const json = {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '书签栏',
          children: [{ type: 'url', name: '有时间', url: 'https://time.example/', date_added: chromeMicros }]
        }
      }
    }
    const item = parseChromeBookmarks(json, 'Default', '个人')?.roots[0]?.children[0]
    expect(item?.createdAt).toBe(created)
  })

  it('roots 缺失或结构不对时返回 null', () => {
    expect(parseChromeBookmarks(null, 'Default', '个人')).toBeNull()
    expect(parseChromeBookmarks({}, 'Default', '个人')).toBeNull()
    expect(parseChromeBookmarks({ roots: 'nope' }, 'Default', '个人')).toBeNull()
    expect(parseChromeBookmarks({ roots: { unrelated: {} } }, 'Default', '个人')).toBeNull()
  })
})

describe('readChromeBookmarks', () => {
  it('正常读取并返回 Profile 名称', () => {
    writeLocalState({ Default: '个人' })
    writeProfile('Default', SAMPLE)

    const read = readChromeBookmarks('Default')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.profileName).toBe('个人')
    expect(read.parsed.bookmarks).toBe(3)
  })

  it('没有 Bookmarks 文件时返回 bookmarks-missing', () => {
    writeProfile('Default')
    expect(readChromeBookmarks('Default')).toEqual({ ok: false, reason: 'bookmarks-missing' })
  })

  it('损坏的 JSON 返回 corrupt，不抛异常', () => {
    const dir = join(root, 'Default')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Bookmarks'), '{ this is not json')
    expect(readChromeBookmarks('Default')).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('拒绝不在白名单里的 Profile 名（路径穿越）', () => {
    expect(readChromeBookmarks('../Default')).toEqual({ ok: false, reason: 'profile-not-found' })
    expect(readChromeBookmarks('Default/../..')).toEqual({ ok: false, reason: 'profile-not-found' })
  })
})
