'use strict';
/*
 * "Will this recording play on Windows?" — asked of WINDOWS, not of Chromium.
 *
 * The recording pipeline was already covered by a test that loaded each file in
 * a Chromium <video> and checked an audio track appeared. Chromium said yes and
 * Windows' own player said:
 *
 *     "We can't play the audio for recording-…. It's encoded in mp4a format
 *      which isn't supported. You can still watch the video."
 *
 * Chromium ships its own AAC decoder and guesses at anything missing; Media
 * Player and Films & TV go through Media Foundation, which does not guess. The
 * file is for the church's own machine, so Media Foundation is the decoder
 * whose opinion counts.
 *
 * IMPORTANT: it is not enough to open the file and read `HasAudio` — that only
 * says a track is DECLARED, and it returns true for exactly the broken files
 * this exists to catch. So this drives Media Foundation's SourceReader the way
 * a player does: it demands decoded PCM (which is what instantiates the AAC
 * decoder, and the step that fails) and then reads real decoded buffers.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = String.raw`param([string]$Path)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class MfProbe
{
    [DllImport("mfplat.dll")] static extern int MFStartup(int version, int flags);
    [DllImport("mfplat.dll")] static extern int MFShutdown();
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode)]
    static extern int MFCreateSourceReaderFromURL(string url, IntPtr attrs, out IMFSourceReader reader);
    [DllImport("mfplat.dll")] static extern int MFCreateMediaType(out IMFMediaType t);

    [ComImport, Guid("70ae66f2-c809-4e4f-8915-bdcb406b7993"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSourceReader
    {
        int GetStreamSelection(int idx, out bool selected);
        int SetStreamSelection(int idx, bool selected);
        int GetNativeMediaType(int idx, int typeIdx, out IMFMediaType type);
        int GetCurrentMediaType(int idx, out IMFMediaType type);
        int SetCurrentMediaType(int idx, IntPtr reserved, IMFMediaType type);
        int SetCurrentPosition(ref Guid fmt, IntPtr pos);
        int ReadSample(int idx, int flags, out int actualIdx, out int streamFlags, out long ts, out IntPtr sample);
    }
    // IMFMediaType : IMFAttributes — all 30 attribute slots must be declared in
    // order so the vtable lines up; only SetGUID (slot 21) is ever called.
    [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaType
    {
        int GetItem(ref Guid k, IntPtr v); int GetItemType(ref Guid k, out int t);
        int CompareItem(); int Compare();
        int GetUINT32(ref Guid k, out int v); int GetUINT64(ref Guid k, out long v);
        int GetDouble(); int GetGUID(ref Guid k, out Guid v);
        int GetStringLength(); int GetString(); int GetAllocatedString();
        int GetBlobSize(ref Guid k, out int size); int GetBlob(); int GetAllocatedBlob(); int GetUnknown();
        int SetItem(); int DeleteItem(); int DeleteAllItems();
        int SetUINT32(ref Guid k, int v); int SetUINT64(); int SetDouble();
        int SetGUID(ref Guid k, ref Guid v);
        int SetString(); int SetBlob(); int SetUnknown();
        int LockStore(); int UnlockStore(); int GetCount(); int GetItemByIndex(); int CopyAllItems();
        int GetMajorType(out Guid g);
    }
    static Guid MF_MT_MAJOR_TYPE  = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    static Guid MF_MT_SUBTYPE     = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    static Guid MFMediaType_Audio = new Guid("73647561-0000-0010-8000-00aa00389b71");
    static Guid MFAudioFormat_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");
    const int FIRST_AUDIO = unchecked((int)0xFFFFFFFD);
    const int ALL_STREAMS = unchecked((int)0xFFFFFFFE);

    public static string Probe(string path)
    {
        int hr = MFStartup(0x00020070, 0);
        if (hr < 0) return "FAILED MFStartup 0x" + hr.ToString("X8");
        try
        {
            IMFSourceReader r;
            hr = MFCreateSourceReaderFromURL(path, IntPtr.Zero, out r);
            if (hr < 0) return "FAILED open 0x" + hr.ToString("X8");
            r.SetStreamSelection(ALL_STREAMS, false);
            hr = r.SetStreamSelection(FIRST_AUDIO, true);
            if (hr < 0) return "NOAUDIO no audio stream 0x" + hr.ToString("X8");
            IMFMediaType want;
            hr = MFCreateMediaType(out want);
            if (hr < 0) return "FAILED MFCreateMediaType 0x" + hr.ToString("X8");
            want.SetGUID(ref MF_MT_MAJOR_TYPE, ref MFMediaType_Audio);
            want.SetGUID(ref MF_MT_SUBTYPE, ref MFAudioFormat_PCM);
            hr = r.SetCurrentMediaType(FIRST_AUDIO, IntPtr.Zero, want);
            if (hr < 0) return "NODECODER Windows cannot build an audio decoder for this track (0x" + hr.ToString("X8") + ")";
            int got = 0, iter = 0;
            while (iter++ < 500)
            {
                int actual, flags; long ts; IntPtr sample;
                hr = r.ReadSample(FIRST_AUDIO, 0, out actual, out flags, out ts, out sample);
                if (hr < 0) return "READFAIL 0x" + hr.ToString("X8") + " after " + got + " buffers";
                if ((flags & 0x4) != 0) break;
                if (sample != IntPtr.Zero) { got++; Marshal.Release(sample); }
                if (got >= 25) break;
            }
            Marshal.ReleaseComObject(r);
            if (got == 0) return "NOSAMPLES decoder built, but no audio came out";
            return "OK decoded " + got + " audio buffers";
        }
        finally { MFShutdown(); }
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp | Out-Null
try { Write-Output ([MfProbe]::Probe((Resolve-Path $Path).Path)) }
catch { Write-Output ("FAILED " + $_.Exception.Message) }
`;

/**
 * Ask Windows' own decoder to play a file's AUDIO.
 * @returns {{ok:boolean, buffers:number, raw:string, skipped?:boolean}}
 */
function mfDecodesAudio(file) {
  if (process.platform !== 'win32') {
    return { ok: true, buffers: 0, raw: 'skipped (not Windows)', skipped: true };
  }
  const ps1 = path.join(os.tmpdir(), 'mw-mf-decode.ps1');
  fs.writeFileSync(ps1, SCRIPT, 'utf-8');
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', file],
      { encoding: 'utf-8', timeout: 90000, windowsHide: true });
  } catch (e) {
    out = 'FAILED ' + (((e.stdout || '') + (e.stderr || '')).trim() || e.message);
  }
  // Add-Type can emit compiler noise; the verdict is the last non-empty line.
  const lines = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const raw = lines.length ? lines[lines.length - 1] : '(no output)';
  const m = /^OK decoded (\d+) audio buffers/.exec(raw);
  return { ok: !!m, buffers: m ? Number(m[1]) : 0, raw };
}

/**
 * Does the file's audio sample entry carry a DecoderSpecificInfo (the
 * AudioSpecificConfig) in its `esds`? This is the exact thing Media Foundation
 * needs and the exact thing a fragmented-MP4 stream-copy leaves out, so it is
 * asserted structurally too — a deterministic check that says WHY, on any OS.
 * @returns {{present:boolean, hex:string, objectType:number, sampleRate:number, channels:number}}
 */
const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function audioSpecificConfig(file) {
  const b = fs.readFileSync(file);
  const at = b.indexOf(Buffer.from('esds'));
  if (at < 0) return { present: false, hex: '', objectType: 0, sampleRate: 0, channels: 0, note: 'no esds box' };
  const box = b.slice(at + 8, at + 8 + 64);
  for (let p = 0; p < box.length - 2; p++) {
    if (box[p] !== 0x05) continue;
    // descriptor lengths come either bare or with the 0x80 0x80 0x80 padding
    const long = box[p + 1] === 0x80 && box[p + 2] === 0x80 && box[p + 3] === 0x80;
    const len = long ? box[p + 4] : box[p + 1];
    const from = p + (long ? 5 : 2);
    if (!len || len > 16 || from + len > box.length) continue;
    const asc = box.slice(from, from + len);
    const bits = (asc[0] << 8) | asc[1];
    return {
      present: true, hex: asc.toString('hex'),
      objectType: (bits >> 11) & 0x1f,
      sampleRate: ASC_RATES[(bits >> 7) & 0x0f] || 0,
      channels: (bits >> 3) & 0x0f,
    };
  }
  return { present: false, hex: '', objectType: 0, sampleRate: 0, channels: 0, note: 'esds has no DecoderSpecificInfo' };
}

module.exports = { mfDecodesAudio, audioSpecificConfig };
