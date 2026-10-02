; <?php exit; ?> DO NOT REMOVE THIS LINE
; RSS-Bridge 設定。RSS のないサイトのフィード化に使うブリッジのみ有効化する。
; 追加したいブリッジがあれば enabled_bridges[] を足す。

[system]
enabled_bridges[] = CssSelectorBridge
enabled_bridges[] = CssSelectorComplexBridge
enabled_bridges[] = CssSelectorFeedExpanderBridge
enabled_bridges[] = XPathBridge

[cache]
type = "file"
