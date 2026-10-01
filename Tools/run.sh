#!/bin/bash
# Build, install and screenshot BrewPhase on the iOS simulator.
#
#   Tools/run.sh [--demo] [--screen <name>] [--tab <cellar|brews|more>]
#                [--lang <system|zh-Hans|en>] [--ask "<question>"]
#                [--ask-more "<question>"]...
#                [--pref "key=value"]...
#                [--udid <udid>] [--shots "2 4 6"]
#
# --demo    seeds six sample bags (only when the store is empty)
# --screen  opens a specific screen for inspection, so the deeper pages can be
#           screenshotted without a UI-test harness. One of:
#           beanDetail | beanEditor | brewEditor | tasting | tastingTimeline |
#           rules | export | language | ask | insights
# --tab     which tab to start on
# --lang    writes the app's own language preference before launching, so the
#           English interface can be checked without touching the device
#           language. "system" removes the preference, which is how "follow the
#           system" is verified. Compare the two on a Chinese simulator: that
#           difference is the only real proof the switch works.
# --ask     opens the ask screen and submits this question on arrival. A
#           simulator cannot tap, so without it the local RAG chain never runs
#           and there is nothing to look at.
# --ask-more  follow-up questions for the same ask screen. Repeatable, and asked
#           one after another, each waiting for the previous answer. Without it
#           the multi-turn context (references, inheritance, switching) cannot
#           be screenshotted — every turn would start from an empty session.
# --pref    writes one string preference before launching. Repeatable. Used to
#           point the app at a local Ollama, e.g.
#             --pref brewphase.rag.answerEngine=ollama
#             --pref brewphase.rag.ollama.baseURL=http://127.0.0.1:11500
#
# Leaves screenshots in /tmp/bp-shots and an OSLog capture in /tmp/bp-app.log.
#
# NOTE: the install step wipes the app's preferences, which is why --lang and
# --pref are applied after installing and before launching.
#
# NOTE: this machine's `xcode-select -p` points at CommandLineTools, so
# DEVELOPER_DIR must be exported or xcodebuild/simctl are not found. A concrete
# simulator destination is also required (a generic one builds for x86_64).
set -u

ROOT=/Users/banmu/Brew/BrewPhase
BUNDLE=com.brewphase.ios
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

UDID=810C6408-DCAB-469B-8D4B-5018BCC9C0FD
DEMO_ARGS=()
SHOTS="2 5"
LANG_SETTING=""
PREFS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --demo)   DEMO_ARGS+=(-BrewPhaseDemo yes); shift ;;
    --screen) DEMO_ARGS+=(-BrewPhaseScreen "$2"); shift 2 ;;
    --tab)    DEMO_ARGS+=(-BrewPhaseTab "$2"); shift 2 ;;
    --ask)    DEMO_ARGS+=(-BrewPhaseAsk "$2"); shift 2 ;;
    --ask-more) DEMO_ARGS+=(-BrewPhaseAskMore "$2"); shift 2 ;;
    --lang)   LANG_SETTING="$2"; shift 2 ;;
    --pref)   PREFS+=("$2"); shift 2 ;;
    --udid)   UDID="$2"; shift 2 ;;
    --shots)  SHOTS="$2"; shift 2 ;;
    *)        echo "unknown option: $1"; exit 2 ;;
  esac
done

echo "== build =="
xcodebuild -project "$ROOT/BrewPhase.xcodeproj" -scheme BrewPhase \
  -destination "platform=iOS Simulator,id=$UDID" -configuration Debug \
  SYMROOT=/tmp/bp2-sym OBJROOT=/tmp/bp2-obj \
  build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 2>&1 \
  | grep -E "error:|BUILD" | head -30
[ -d /tmp/bp2-sym/Debug-iphonesimulator/BrewPhase.app ] || { echo "no app produced"; exit 1; }

echo "== boot =="
xcrun simctl boot "$UDID" 2>/dev/null
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1

echo "== install =="
xcrun simctl terminate "$UDID" $BUNDLE 2>/dev/null
xcrun simctl uninstall "$UDID" $BUNDLE 2>/dev/null
xcrun simctl install "$UDID" /tmp/bp2-sym/Debug-iphonesimulator/BrewPhase.app

if [ -n "$LANG_SETTING" ]; then
  echo "== language: $LANG_SETTING =="
  if [ "$LANG_SETTING" = "system" ]; then
    xcrun simctl spawn "$UDID" defaults delete $BUNDLE BrewPhase.AppLanguage 2>/dev/null
  else
    xcrun simctl spawn "$UDID" defaults write $BUNDLE BrewPhase.AppLanguage -string "$LANG_SETTING"
  fi
  echo "   stored: $(xcrun simctl spawn "$UDID" defaults read $BUNDLE BrewPhase.AppLanguage 2>&1 | head -1)"
fi

for pref in "${PREFS[@]:-}"; do
  [ -z "$pref" ] && continue
  key="${pref%%=*}"
  value="${pref#*=}"
  echo "== pref: $key = $value =="
  xcrun simctl spawn "$UDID" defaults write $BUNDLE "$key" -string "$value"
done

rm -rf /tmp/bp-shots; mkdir -p /tmp/bp-shots
rm -f /tmp/bp-app.log
( xcrun simctl spawn "$UDID" log stream --level debug --style compact \
    --predicate 'subsystem BEGINSWITH "com.brewphase"' > /tmp/bp-app.log 2>&1 ) &
LOGPID=$!

echo "== launch ${DEMO_ARGS[*]:-} =="
xcrun simctl launch "$UDID" $BUNDLE "${DEMO_ARGS[@]}" >/dev/null

prev=0
for t in $SHOTS; do
  sleep $(( t - prev )); prev=$t
  xcrun simctl io "$UDID" screenshot "/tmp/bp-shots/t${t}.png" >/dev/null 2>&1
  echo "captured t=${t}s"
done

sleep 1
kill $LOGPID 2>/dev/null
echo "== app log =="
grep -vE "getpwuid|Filtering the log|signal 15|^$" /tmp/bp-app.log | head -40
echo "== shots =="
ls /tmp/bp-shots
