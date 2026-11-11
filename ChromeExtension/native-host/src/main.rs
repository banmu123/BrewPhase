//! BrewPhase Chrome Companion — Native Messaging Host.
//!
//! 职责只有三件事：
//! 1. 按 Chrome 的协议读 stdin（4 字节 native-endian 长度 + UTF-8 JSON）；
//! 2. 通过本机 IPC（Windows Named Pipe / Unix domain socket）转发给 Desktop，
//!    请求本身**原样透传**——Host 不解析网页内容，也不写数据库；
//! 3. 把 Desktop 的响应按协议写回 stdout。
//!
//! stdout 只允许出现 Native Messaging 帧；所有日志走 stderr，否则 Chrome
//! 会把日志当成消息体解析失败。
//!
//! Desktop 不在线时返回 `APP_NOT_RUNNING`，绝不假装保存成功。

use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process;

/// Chrome 单条消息上限（Chrome 自己给到 64MB，这里收紧到 8MB）。
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const PROTOCOL_VERSION: u32 = 1;
const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

trait ReadWrite: Read + Write + Sized {
    fn try_clone_stream(&self) -> io::Result<Self>;
}

impl ReadWrite for fs::File {
    fn try_clone_stream(&self) -> io::Result<Self> {
        self.try_clone()
    }
}

#[cfg(unix)]
impl ReadWrite for std::os::unix::net::UnixStream {
    fn try_clone_stream(&self) -> io::Result<Self> {
        self.try_clone()
    }
}

#[derive(Debug)]
struct HostConfig {
    endpoint: String,
    token: String,
}

struct Connection<S: ReadWrite> {
    reader: BufReader<S>,
    writer: S,
}

impl<S: ReadWrite> Connection<S> {
    fn new(stream: S) -> io::Result<Self> {
        let reader = BufReader::new(stream.try_clone_stream()?);
        Ok(Self { reader, writer: stream })
    }

    /// 发送一行 NDJSON，读回一行响应。超时由 Desktop 侧关闭连接来体现。
    fn send(&mut self, line: &str) -> io::Result<String> {
        self.writer.write_all(line.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        let mut response = String::new();
        let read = self.reader.read_line(&mut response)?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "desktop closed the pipe"));
        }
        Ok(response.trim_end_matches(['\r', '\n']).to_string())
    }
}

fn main() {
    eprintln!("[brewphase-chrome-host] start v{}", HOST_VERSION);

    let config = match load_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[brewphase-chrome-host] config unavailable: {}", error);
            // 仍要消费 Chrome 的消息并明确拒绝，否则 popup 会一直等。
            serve_unavailable("BrewPhase Chrome Companion is not installed correctly");
            return;
        }
    };

    let mut connection = connect(&config);
    if connection.is_none() {
        eprintln!("[brewphase-chrome-host] desktop is not reachable at {}", config.endpoint);
    }

    let stdin = io::stdin();
    let mut input = stdin.lock();

    loop {
        let message = match read_frame(&mut input) {
            Ok(Some(Frame::Message(message))) => message,
            Ok(Some(Frame::TooLarge(size))) => {
                // 不能安全跳过 body：回一条错误后结束，由 Chrome 关闭连接。
                eprintln!("[brewphase-chrome-host] frame too large: {} bytes", size);
                write_error("", "INVALID_REQUEST", "message exceeds the size limit");
                break;
            }
            Ok(None) => break,
            Err(error) => {
                eprintln!("[brewphase-chrome-host] read frame failed: {}", error);
                break;
            }
        };

        if message.len() > MAX_MESSAGE_BYTES {
            eprintln!("[brewphase-chrome-host] message too large: {} bytes", message.len());
            let request_id = extract_string_lossy(&message, "requestId").unwrap_or_default();
            write_error(&request_id, "INVALID_REQUEST", "message exceeds the size limit");
            continue;
        }

        let text = match std::str::from_utf8(&message) {
            Ok(text) => text.trim().to_string(),
            Err(_) => {
                let request_id = extract_string_lossy(&message, "requestId").unwrap_or_default();
                write_error(&request_id, "INVALID_REQUEST", "message is not valid UTF-8");
                continue;
            }
        };

        if text.is_empty() {
            continue;
        }

        let request_id = extract_string(&text, "requestId").unwrap_or_default();

        // 断线后重连一次：Desktop 重启 / 首次打开 popup 都能自愈。
        if connection.is_none() {
            connection = connect(&config);
        }
        let Some(active) = connection.as_mut() else {
            write_error(
                &request_id,
                "APP_NOT_RUNNING",
                "BrewPhase Desktop is not running",
            );
            continue;
        };

        match active.send(&text) {
            Ok(response) if is_valid_response(&response) => {
                if let Err(error) = write_frame(response.as_bytes()) {
                    eprintln!("[brewphase-chrome-host] write response failed: {}", error);
                    break;
                }
            }
            Ok(_) => {
                write_error(&request_id, "INTERNAL_ERROR", "desktop returned an invalid response");
            }
            Err(error) => {
                eprintln!("[brewphase-chrome-host] desktop connection lost: {}", error);
                connection = None;
                write_error(
                    &request_id,
                    "APP_NOT_RUNNING",
                    "BrewPhase Desktop is not running",
                );
            }
        }
    }

    eprintln!("[brewphase-chrome-host] exit");
}

// MARK: - Desktop 连接

#[cfg(windows)]
fn connect(config: &HostConfig) -> Option<Connection<fs::File>> {
    use std::fs::OpenOptions;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.endpoint)
        .ok()?;
    let mut connection = Connection::new(file).ok()?;
    handshake(&mut connection, &config.token).then_some(connection)
}

#[cfg(unix)]
fn connect(config: &HostConfig) -> Option<Connection<std::os::unix::net::UnixStream>> {
    let stream = std::os::unix::net::UnixStream::connect(&config.endpoint).ok()?;
    let mut connection = Connection::new(stream).ok()?;
    handshake(&mut connection, &config.token).then_some(connection)
}

fn handshake<S: ReadWrite>(connection: &mut Connection<S>, token: &str) -> bool {
    let hello = format!(
        "{{\"type\":\"hello\",\"token\":\"{}\",\"version\":{}}}",
        escape_json(token),
        PROTOCOL_VERSION
    );
    match connection.send(&hello) {
        Ok(ack) => ack.contains("\"ok\":true"),
        Err(error) => {
            eprintln!("[brewphase-chrome-host] handshake failed: {}", error);
            false
        }
    }
}

// MARK: - Chrome 帧协议

enum Frame {
    Message(Vec<u8>),
    TooLarge(usize),
}

/// 读一条 Chrome 消息；`Ok(None)` = stdin 正常结束（Chrome 关掉 port）。
fn read_frame<R: Read>(input: &mut R) -> io::Result<Option<Frame>> {
    let mut length = [0_u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_ne_bytes(length) as usize;
    if size == 0 {
        return Ok(Some(Frame::Message(Vec::new())));
    }
    if size > MAX_MESSAGE_BYTES {
        // 不分配超限缓冲区：上层回 INVALID_REQUEST 后结束。
        return Ok(Some(Frame::TooLarge(size)));
    }
    let mut buffer = vec![0_u8; size];
    input.read_exact(&mut buffer)?;
    Ok(Some(Frame::Message(buffer)))
}

fn write_frame(payload: &[u8]) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    let size = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response is too large"))?;
    stdout.write_all(&size.to_ne_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

fn write_error(request_id: &str, code: &str, message: &str) {
    let body = format!(
        "{{\"version\":{},\"requestId\":\"{}\",\"success\":false,\"code\":\"{}\",\"message\":\"{}\"}}",
        PROTOCOL_VERSION,
        escape_json(request_id),
        code,
        escape_json(message)
    );
    if let Err(error) = write_frame(body.as_bytes()) {
        eprintln!("[brewphase-chrome-host] write error frame failed: {}", error);
    }
}

/// Desktop 不可达时仍要逐条应答，避免 popup 卡在「正在保存」。
fn serve_unavailable(message: &str) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        match read_frame(&mut input) {
            Ok(Some(Frame::Message(frame))) => {
                let request_id = extract_string_lossy(&frame, "requestId").unwrap_or_default();
                write_error(&request_id, "APP_NOT_RUNNING", message);
            }
            Ok(Some(Frame::TooLarge(_))) => {
                write_error("", "INVALID_REQUEST", "message exceeds the size limit");
                break;
            }
            _ => break,
        }
    }
}

// MARK: - 极简 JSON 读取（不解析网页内容）

/// 只取顶层字符串字段：Host 不解释页面数据，只需要 requestId / endpoint / token。
fn extract_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let start = json.find(&pattern)? + pattern.len();
    let rest = &json[start..];
    let colon = rest.find(':')?;
    let rest = &rest[colon + 1..];
    let quote = rest.find('"')?;
    let mut chars = rest[quote + 1..].chars().peekable();
    let mut out = String::new();
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if escaped {
            match ch {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'u' => {
                    // \uXXXX：跳过 4 个十六进制字符（requestId/路径不会用到）。
                    for _ in 0..4 {
                        chars.next();
                    }
                }
                other => out.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

fn extract_string_lossy(bytes: &[u8], key: &str) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    extract_string(&text, key)
}

fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => {}
            other => out.push(other),
        }
    }
    out
}

fn is_valid_response(response: &str) -> bool {
    response.starts_with('{')
        && response.ends_with('}')
        && response.contains("\"requestId\"")
        && response.contains("\"code\"")
}

// MARK: - 配置

fn load_config() -> Result<HostConfig, String> {
    let path = config_path().ok_or_else(|| "host-config.json not found".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|error| format!("{}: {}", path.display(), error))?;
    let endpoint = extract_string(&raw, "endpoint").ok_or_else(|| "missing endpoint".to_string())?;
    let token = extract_string(&raw, "token").ok_or_else(|| "missing token".to_string())?;
    if endpoint.is_empty() || token.len() < 16 {
        return Err("endpoint or token is empty".to_string());
    }
    Ok(HostConfig { endpoint, token })
}

fn config_path() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("BREWPHASE_CHROME_HOST_CONFIG") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe = env::current_exe().ok()?;
    let candidate = exe.parent()?.join("host-config.json");
    candidate.is_file().then_some(candidate)
}

#[allow(dead_code)]
fn exit_with(code: i32) -> ! {
    process::exit(code)
}
