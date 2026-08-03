-- measure-voiceover.applescript — 実機 VoiceOver の読み上げを逐語で取得する
--
-- 使い方:
--     osascript tools/measure-voiceover.applescript [走査ステップ数] [対象ページの URL]
--     osascript tools/measure-voiceover.applescript 22
--     osascript tools/measure-voiceover.applescript 14 file:///…/compare/006-counting-basis/g-manual-checks.html
--     ※ 引数は順不同（数値 = ステップ数 / file: か http で始まる文字列 = 対象ページ）。
--       URL を省くと property pageURL（005 の題材）を測る。
--
-- 測るもの:
--     Safari で対象ページを開き、VoiceOver カーソルをウェブ領域内で 1 項目ずつ進めながら
--     `content of last phrase` を逐語で取得する。
--
-- なぜ focus() ではなく VO カーソル走査なのか:
--     測定対象にはフォーカスできない実装（素の div / role だけの div）が含まれる。
--     それらに tabindex を足して focus() で測ると、段階 0 と段階 1 を分けている当の属性を
--     足すことになり、測る対象が変わってしまう。ページを一切変えずに測るには VO 走査が要る。
--
-- ──────────────────────────────────────────────────────────────
-- 🔴 実行前に必要な環境（5 層・html-basics 002 / 005 で確定）
--     1. /usr/bin/osascript をアクセシビリティに登録
--        ※ System Events のプロセス列挙が通っても、キー送出は別の権限。
--          「近い操作が通ったこと」を根拠にせず、key code の送出そのもので検算する
--     2. シェルを抱えている親アプリ（VS Code 等）もアクセシビリティに登録
--     3. VoiceOver ユーティリティで AppleScript による制御を許可
--     4. Safari の「開発 → Apple Events からの JavaScript を許可」
--     5. 🔴 Dictation のショートカットを無効化する
--        macOS の既定は「Control キーを 2 回押す」（AppleSymbolicHotKeys の 164・
--        type = modifier / 262144）。本スクリプトは control 修飾キーを多用するため、
--        無効化しないと音声入力ダイアログが割り込み、以降の読み上げがすべてその内容になる。
--        確認: defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys | grep -A 6 '164 ='
--        測定後は復元すること。
--
-- 🔴 測定値を読む前に「測れているか」を検証する
--     走査前と走査中に VO カーソルがページ内にあるかを検算し、ページ外なら値を返さず中止する。
--     このガードが無いと、システムダイアログの読み上げが測定値として並んだ表ができる
--     （005 の実測では 3 回の走査を中止した）。
--
-- 🔴 役割語の言語はシステムの UI 言語に従う
--     clickable / button といった役割語は「音声（voice）」ではなく VoiceOver の UI 言語で決まり、
--     UI 言語はシステム第一言語に紐づく。日本語の役割語を測るには
--     システム第一言語を ja へ変更してログアウト / ログインする必要がある
--     （音声を Kyoko に変えるだけでは変わらない・005 で確定）。
-- ──────────────────────────────────────────────────────────────

property pageURL : "file://<REPO>/compare/005-aria-stages/index.html"

on run argv
	set stepCount to 22
	set targetURL to pageURL
	-- 引数は順不同で受ける（数値 = 走査ステップ数 / file: か http で始まる文字列 = 対象ページ）
	repeat with a in argv
		set av to a as text
		if av starts with "file:" or av starts with "http" then
			set targetURL to av
		else
			set stepCount to av as integer
		end if
	end repeat

	set report to {}

	-- 前提 0: VoiceOver が動いていなければ何も測れない
	if not my voiceOverRunning() then
		set end of report to "🔴 中止: VoiceOver が起動していません（command + F5 で起動する）"
		return my joinList(report, linefeed)
	end if

	-- 対象ページのウインドウを前面へ
	tell application "Safari"
		activate
		set target to missing value
		repeat with w in windows
			try
				if (URL of current tab of w) is targetURL then set target to w
			end try
		end repeat
		if target is missing value then
			make new document with properties {URL:targetURL}
			delay 2
			set target to window 1
		end if
		set index of target to 1
	end tell
	delay 2

	tell application "Safari"
		set t to do JavaScript "document.title" in current tab of window 1
	end tell
	set end of report to "対象: " & t

	-- 前提 1: Developer（Web インスペクタ）ウインドウを前面から退ける
	--   Safari の AppleScript windows コレクションにこのウインドウは現れないため、
	--   Safari 側だけを見ていると存在に気づけない。System Events から見て AXRaise する。
	set devFound to false
	tell application "System Events"
		tell process "Safari"
			set pageWin to missing value
			repeat with w in windows
				set wn to ""
				try
					set wn to (name of w) as text
				end try
				if wn is "Developer" then
					set devFound to true
				else if wn is t then
					set pageWin to w
				end if
			end repeat
			if pageWin is not missing value then perform action "AXRaise" of pageWin
		end tell
	end tell
	delay 1
	if devFound then set end of report to "⚠️ Developer ウインドウを検出したため、ページのウインドウを前面へ上げた"

	-- 前提 2: 走査の階層を戻す
	--   前回の実行で要素のテキスト内部に入ったままだと、そこから走査が始まってしまう。
	repeat 3 times
		tell application "System Events"
			key code 126 using {control down, option down, shift down} -- VO+Shift+↑（interact 終了）
		end tell
		delay 0.4
	end repeat

	-- 前提 3: 🔴 web content グループに「いること」を積極的に確認する
	--   除外語リストでは塞がらない。アドレスバー（In edit text …）も
	--   要素テキストの内部（In text …）も、禁止語に当たらないまま素通りし、
	--   file:/// や 段階 / 1： といった値が測定結果として並ぶ表ができてしまう。
	--   「web content に到達したこと」を確認できるまで進み、届かなければ測らない。
	set landed to false
	set trail to {}
	repeat 30 times
		set pk to my phrase()
		set end of trail to pk
		if my isWebContent(pk) then
			set landed to true
			exit repeat
		end if
		tell application "System Events"
			key code 124 using {control down, option down} -- VO+→
		end tell
		delay 0.6
	end repeat
	if not landed then
		set end of report to "🔴 中止: web content グループに到達できませんでした（30 手で打ち切り）"
		set end of report to "   直近の読み上げ: " & my joinList(my lastN(trail, 5), " / ")
		return my joinList(report, linefeed)
	end if
	set end of report to "web content に到達: " & my phrase()

	-- ウェブ領域へ interact（VO+Shift+↓）
	tell application "System Events"
		key code 125 using {control down, option down, shift down}
	end tell
	delay 2

	set p0 to my phrase()
	set end of report to "interact 直後: " & p0

	-- 前提 4: interact 後の位置を検算する（ページ外 / テキスト内部のどちらも中止）
	if my isOutsidePage(p0) then
		set end of report to "🔴 中止: VO カーソルがページ外にあります → " & p0
		return my joinList(report, linefeed)
	end if
	if my isInsideText(p0) then
		set end of report to "🔴 中止: 要素のテキスト内部にいます。走査の階層が違うため測定しません → " & p0
		return my joinList(report, linefeed)
	end if

	repeat with i from 1 to stepCount
		tell application "System Events"
			key code 124 using {control down, option down} -- VO+→
		end tell
		delay 0.9
		set p to my phrase()
		set end of report to (i as text) & ": " & p
		if my isOutsidePage(p) then
			set end of report to "🔴 中止: 走査中にページ外へ出ました → " & p
			exit repeat
		end if
		if my isInsideText(p) then
			set end of report to "🔴 中止: 走査中に要素のテキスト内部へ入りました → " & p
			exit repeat
		end if
	end repeat

	return my joinList(report, linefeed)
end run

on phrase()
	try
		tell application "VoiceOver"
			set p to content of last phrase
		end tell
	on error errMsg number errNum
		return "取得エラー(" & errNum & ") " & errMsg
	end try
	if p is missing value then return "(missing value)"
	return p
end phrase

on voiceOverRunning()
	tell application "System Events" to return (exists (process "VoiceOver"))
end voiceOverRunning

-- web content グループに載っているか（到達の積極確認）
on isWebContent(p)
	if p is missing value then return false
	return (p contains "web content") or (p contains "HTML content")
end isWebContent

-- ページ外（システムダイアログ / インスペクタ / ツールバー / アドレスバー）
on isOutsidePage(p)
	if p is missing value then return false
	return (p contains "Dictation") or (p contains "Developer") or (p contains "toolbar") or (p contains "edit text") or (p contains "address")
end isOutsidePage

-- 要素のテキスト内部（1 段深い階層に入ってしまった状態）
on isInsideText(p)
	if p is missing value then return false
	return (p starts with "In text ") or (p contains "In edit text")
end isInsideText

on lastN(lst, n)
	set c to count of lst
	if c ≤ n then return lst
	return items (c - n + 1) thru c of lst
end lastN

on joinList(lst, sep)
	set {tid, AppleScript's text item delimiters} to {AppleScript's text item delimiters, sep}
	set s to lst as text
	set AppleScript's text item delimiters to tid
	return s
end joinList
