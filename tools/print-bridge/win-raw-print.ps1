param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PrinterName
)
$ErrorActionPreference = 'Stop'
# Fixed, local script: never build PowerShell source from the request.
# Requires a locally installed Windows queue for the USB-connected Epson.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlateformRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DocInfo {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo info);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr handle, byte[] data, int length, out int written);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr handle);
}
'@

try {
    $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    if ($data.Length -lt 1 -or $data.Length -gt 65536) { throw 'INVALID_RAW_DOCUMENT' }
    $handle = [IntPtr]::Zero
    if (-not [PlateformRawPrinter]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) {
        throw 'PRINTER_QUEUE_UNAVAILABLE'
    }
    $documentStarted = $false
    $pageStarted = $false
    $completed = $false
    try {
        $info = New-Object PlateformRawPrinter+DocInfo
        $info.pDocName = 'Plateform - Documento non fiscale'
        $info.pOutputFile = $null
        $info.pDatatype = 'RAW'
        if ([PlateformRawPrinter]::StartDocPrinter($handle, 1, $info) -eq 0) {
            throw 'START_DOC_FAILED'
        }
        $documentStarted = $true
        if (-not [PlateformRawPrinter]::StartPagePrinter($handle)) {
            throw 'START_PAGE_FAILED'
        }
        $pageStarted = $true
        $written = 0
        if (-not [PlateformRawPrinter]::WritePrinter($handle, $data, $data.Length, [ref]$written)) {
            throw 'WRITE_PRINTER_FAILED'
        }
        if ($written -ne $data.Length) { throw 'PARTIAL_PRINT_WRITE' }
        $completed = $true
    }
    finally {
        if ($pageStarted) {
            if (-not [PlateformRawPrinter]::EndPagePrinter($handle)) { $completed = $false }
        }
        if ($documentStarted) {
            if (-not [PlateformRawPrinter]::EndDocPrinter($handle)) { $completed = $false }
        }
        [void][PlateformRawPrinter]::ClosePrinter($handle)
    }
    if (-not $completed) { throw 'SPOOL_OUTCOME_UNKNOWN' }
    exit 0
}
catch {
    # Do not echo the document or its contents into process logs.
    [Console]::Error.WriteLine('RAW_PRINT_FAILED')
    exit 1
}
