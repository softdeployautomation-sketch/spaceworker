#requires -Version 5.1
<#
.SYNOPSIS
  AES-256-GCM helpers. Prefers .NET AesGcm (pwsh 7 / .NET 5+); falls back to
  Windows CNG (BCrypt P/Invoke, correct auth-info interop) on Windows PowerShell 5.1.
  Format: [12-byte nonce][ciphertext][16-byte tag]. Key = 32 bytes, caller-supplied only.
.SECURITY
  Key material lives only in byte[] parameters; never serialized, logged, or written to disk.
#>

function Protect-Gcm {
    <# .SYNOPSIS AES-256-GCM seal. Returns [12-byte nonce][ciphertext][16-byte tag]. #>
    param([Parameter(Mandatory=$true)][byte[]]$PlainText, [Parameter(Mandatory=$true)][byte[]]$Key)
    if ($Key.Length -ne 32) { throw 'AES-256-GCM requires a 32-byte key' }

    if ('System.Security.Cryptography.AesGcm' -as [type]) {
        $nonce = New-Object byte[] 12
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
        $tag = New-Object byte[] 16
        $ct  = New-Object byte[] $PlainText.Length
        $aes = [System.Security.Cryptography.AesGcm]::new($Key)
        try { $aes.Encrypt($nonce, $PlainText, $ct, $tag) } finally { $aes.Dispose() }
        return (Join-GcmParts $nonce $ct $tag)
    }

    # Windows PowerShell 5.1 → CNG
    return [GcmNative]::Seal($Key, $PlainText)
}

function Unprotect-Gcm {
    <# .SYNOPSIS AES-256-GCM open. Throws on tag mismatch (wrong key or tampering). #>
    param([Parameter(Mandatory=$true)][byte[]]$Data, [Parameter(Mandatory=$true)][byte[]]$Key)
    if ($Key.Length -ne 32) { throw 'AES-256-GCM requires a 32-byte key' }
    if ($Data.Length -lt 28) { throw 'data too short for nonce+tag' }

    if ('System.Security.Cryptography.AesGcm' -as [type]) {
        $nonce = New-Object byte[] 12; $tag = New-Object byte[] 16
        $ctLen = $Data.Length - 28
        $ct = New-Object byte[] $ctLen
        [Array]::Copy($Data, 0, $nonce, 0, 12)
        [Array]::Copy($Data, 12, $ct, 0, $ctLen)
        [Array]::Copy($Data, 12 + $ctLen, $tag, 0, 16)
        $pt = New-Object byte[] $ctLen
        $aes = [System.Security.Cryptography.AesGcm]::new($Key)
        try { $aes.Decrypt($nonce, $ct, $tag, $pt) }
        catch [System.Security.Cryptography.AuthenticationFailureException] {
            throw [System.Security.Cryptography.CryptographicException]::new('GCM tag mismatch (tampered or wrong key)')
        }
        finally { $aes.Dispose() }
        return $pt
    }

    return [GcmNative]::Open($Key, $Data)
}

function Join-GcmParts {
    param([byte[]]$Nonce, [byte[]]$CipherText, [byte[]]$Tag)
    $out = New-Object byte[] ($Nonce.Length + $CipherText.Length + $Tag.Length)
    [Array]::Copy($Nonce, 0, $out, 0, 12)
    [Array]::Copy($CipherText, 0, $out, 12, $CipherText.Length)
    [Array]::Copy($Tag, 0, $out, 12 + $CipherText.Length, 16)
    return $out
}

if (-not ('GcmNative' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class GcmNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct AUTH_INFO
    {
        public int cbSize;
        public int dwInfoVersion;
        public IntPtr pbNonce;      public int cbNonce;
        public IntPtr pbAuthData;   public int cbAuthData;
        public IntPtr pbTag;        public int cbTag;
        public IntPtr pbMacContext; public int cbMacContext;
        public ulong dwFlags;
    }

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptOpenAlgorithmProvider(out IntPtr hAlg, string algId, string impl, uint flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptSetProperty(IntPtr hObj, string prop, byte[] val, int cb, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptGenerateSymmetricKey(IntPtr hAlg, out IntPtr hKey, IntPtr keyObj, int objLen, byte[] secret, int len, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptEncrypt(IntPtr hKey, byte[] input, int inLen, IntPtr authInfo, IntPtr iv, int ivLen, byte[] output, int outLen, out int result, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDecrypt(IntPtr hKey, byte[] input, int inLen, IntPtr authInfo, IntPtr iv, int ivLen, byte[] output, int outLen, out int result, uint flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDestroyKey(IntPtr hKey);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptCloseAlgorithmProvider(IntPtr hAlg, uint flags);

    private const int STATUS_AUTH_TAG_MISMATCH = unchecked((int)0xC000A002);

    private static IntPtr Pin(byte[] data)
    {
        IntPtr p = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, p, data.Length);
        return p;
    }

    // BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO, native x64 = 88 bytes:
    // cbSize@0, dwInfoVersion@4, pbNonce@8, cbNonce@16, pbAuthData@24, cbAuthData@32,
    // pbTag@40, cbTag@48, pbMacContext@56, cbMacContext@64, cbAAD@68,
    // cbData (ULONGLONG)@72, dwFlags@80. x86 = 48 bytes (flags@44).
    // cbSize must equal the native size exactly — BCrypt returns 0xC000000D otherwise.
    private static IntPtr BuildAuthInfo(IntPtr pNonce, int cbNonce, IntPtr pTag, int cbTag)
    {
        bool x64 = IntPtr.Size == 8;
        int size = x64 ? 88 : 48;
        IntPtr p = Marshal.AllocHGlobal(size);
        for (int i = 0; i < size; i += 4) Marshal.WriteInt32(p, i, 0);
        Marshal.WriteInt32(p, 0, size);            // cbSize
        Marshal.WriteInt32(p, 4, 1);               // dwInfoVersion
        Marshal.WriteIntPtr(p, 8, pNonce);         // pbNonce
        Marshal.WriteInt32(p, x64 ? 16 : 12, cbNonce);
        // pbAuthData NULL/0, pbTag:
        Marshal.WriteIntPtr(p, x64 ? 40 : 24, pTag);
        Marshal.WriteInt32(p, x64 ? 48 : 28, cbTag);
        // pbMacContext NULL/0, cbMacContext 0, cbAAD 0, cbData 0, dwFlags 0 (all zeroed)
        return p;
    }

    private static void Ctx(byte[] key, byte[] nonce, byte[] tag, out IntPtr hAlg, out IntPtr hKey, out IntPtr pNonce, out IntPtr pTag, out IntPtr pInfo, bool encrypting)
    {
        Check(BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0), "open alg");
        byte[] cm = EncodingW("ChainingModeGCM");
        Check(BCryptSetProperty(hAlg, "ChainingMode", cm, cm.Length, 0), "set chaining mode");
        Check(BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0), "gen key");
        pNonce = Pin(nonce);
        pTag = encrypting ? Marshal.AllocHGlobal(16) : Pin(tag);
        pInfo = BuildAuthInfo(pNonce, 12, pTag, 16);
    }

    private static void Free(IntPtr hAlg, IntPtr hKey, IntPtr pNonce, IntPtr pTag, IntPtr pInfo)
    {
        if (pNonce != IntPtr.Zero) Marshal.FreeHGlobal(pNonce);
        if (pTag != IntPtr.Zero) Marshal.FreeHGlobal(pTag);
        if (pInfo != IntPtr.Zero) Marshal.FreeHGlobal(pInfo);
        if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
        if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
    }

    private static void Check(int status, string what)
    {
        if (status < 0) throw new InvalidOperationException(what + " failed: 0x" + status.ToString("X8"));
    }
    private static byte[] EncodingW(string s)
    {
        byte[] b = new byte[(s.Length + 1) * 2];
        System.Text.Encoding.Unicode.GetBytes(s, 0, s.Length, b, 0);
        return b;
    }

    /// <summary>Seal: returns nonce(12) || ciphertext || tag(16).</summary>
    public static byte[] Seal(byte[] key, byte[] plain)
    {
        if (key == null || key.Length != 32) throw new ArgumentException("key must be 32 bytes");
        byte[] nonce = new byte[12];
        using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create())
            rng.GetBytes(nonce);

        IntPtr hAlg, hKey, pNonce, pTag, pInfo;
        Ctx(key, nonce, null, out hAlg, out hKey, out pNonce, out pTag, out pInfo, true);
        try
        {
            byte[] ct = new byte[plain.Length];
            byte[] tag = new byte[16];
            int written;
            Check(BCryptEncrypt(hKey, plain, plain.Length, pInfo, IntPtr.Zero, 0, ct, ct.Length, out written, 0), "encrypt");
            Marshal.Copy(pTag, tag, 0, 16);
            byte[] result = new byte[12 + written + 16];
            Array.Copy(nonce, 0, result, 0, 12);
            Array.Copy(ct, 0, result, 12, written);
            Array.Copy(tag, 0, result, 12 + written, 16);
            return result;
        }
        finally { Free(hAlg, hKey, pNonce, pTag, pInfo); }
    }

    /// <summary>Open: input nonce(12) || ciphertext || tag(16); throws on tag mismatch.</summary>
    public static byte[] Open(byte[] key, byte[] sealedData)
    {
        if (key == null || key.Length != 32) throw new ArgumentException("key must be 32 bytes");
        if (sealedData == null || sealedData.Length < 28) throw new ArgumentException("data too short");

        int ctLen = sealedData.Length - 28;
        byte[] nonce = new byte[12]; Array.Copy(sealedData, 0, nonce, 0, 12);
        byte[] ct = new byte[ctLen]; Array.Copy(sealedData, 12, ct, 0, ctLen);
        byte[] tag = new byte[16];   Array.Copy(sealedData, 12 + ctLen, tag, 0, 16);

        IntPtr hAlg, hKey, pNonce, pTag, pInfo;
        Ctx(key, nonce, tag, out hAlg, out hKey, out pNonce, out pTag, out pInfo, false);
        try
        {
            byte[] pt = new byte[ctLen];
            int written;
            int st = BCryptDecrypt(hKey, ct, ctLen, pInfo, IntPtr.Zero, 0, pt, pt.Length, out written, 0);
            if (st == STATUS_AUTH_TAG_MISMATCH)
                throw new System.Security.Cryptography.CryptographicException("GCM tag mismatch (tampered or wrong key)");
            Check(st, "decrypt");
            if (written != ctLen) throw new InvalidOperationException("short plaintext");
            return pt;
        }
        finally { Free(hAlg, hKey, pNonce, pTag, pInfo); }
    }

}
"@ -ErrorAction Stop
}
