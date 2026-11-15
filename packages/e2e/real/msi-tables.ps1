# Reads three tables of an MSI through the Windows Installer COM object (read-only; no elevation) and prints
# tab separated lines: F, fileKey, component, fileName / C, component, directory / D, dir, parent, defaultDir.
param([string]$Path)
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($Path, 0))
function Dump($tag, $sql, $n) {
  $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
  $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
  while ($true) {
    $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    if ($null -eq $rec) { break }
    $cols = @($tag)
    for ($i = 1; $i -le $n; $i++) { $cols += $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @($i)) }
    [Console]::Out.WriteLine(($cols -join "`t"))
  }
  $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
}
Dump 'F' 'SELECT File, Component_, FileName FROM File' 3
Dump 'C' 'SELECT Component, Directory_ FROM Component' 2
Dump 'D' 'SELECT Directory, Directory_Parent, DefaultDir FROM Directory' 3
