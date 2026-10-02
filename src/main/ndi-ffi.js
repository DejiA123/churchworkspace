'use strict';
/**
 * Shared NDI FFI bindings (koffi) for the flat C API of the NDI SDK runtime.
 * Used from both the main thread (discovery — fast, non-blocking calls) and the
 * NDI receiver worker thread (the blocking capture loop). Kept in one place so
 * the struct layouts stay identical on both sides.
 *
 * Read frame bytes with koffi.decode() into a typed array, NEVER koffi.view():
 * koffi.view returns a zero-copy ArrayBuffer over native memory that crashes
 * Electron's V8 fatally ("detached arraybuffer"), while decode copies into
 * V8-owned memory and is safe everywhere.
 */

function loadNdi(dllPath) {
  const koffi = require('koffi');
  const lib = koffi.load(dllPath);

  const NDIlib_source_t = koffi.struct('NDIlib_source_t', { p_ndi_name: 'str', p_url_address: 'str' });
  const NDIlib_find_create_t = koffi.struct('NDIlib_find_create_t', {
    show_local_sources: 'bool', p_groups: 'str', p_extra_ips: 'str',
  });
  const NDIlib_video_frame_v2_t = koffi.struct('NDIlib_video_frame_v2_t', {
    xres: 'int', yres: 'int', FourCC: 'int', frame_rate_N: 'int', frame_rate_D: 'int',
    picture_aspect_ratio: 'float', frame_format_type: 'int', timecode: 'int64',
    p_data: 'void*', line_stride_in_bytes: 'int', p_metadata: 'str', timestamp: 'int64',
  });
  const NDIlib_audio_frame_v3_t = koffi.struct('NDIlib_audio_frame_v3_t', {
    sample_rate: 'int', no_channels: 'int', no_samples: 'int', timecode: 'int64',
    FourCC: 'int', p_data: 'void*', channel_stride_in_bytes: 'int', p_metadata: 'str', timestamp: 'int64',
  });
  const NDIlib_recv_create_v3_t = koffi.struct('NDIlib_recv_create_v3_t', {
    source_to_connect_to: NDIlib_source_t, color_format: 'int', bandwidth: 'int',
    allow_video_fields: 'bool', p_ndi_recv_name: 'str',
  });
  const NDIlib_recv_queue_t = koffi.struct('NDIlib_recv_queue_t', {
    video_frames: 'int', audio_frames: 'int', metadata_frames: 'int',
  });

  const NDIlib_send_create_t = koffi.struct('NDIlib_send_create_t', {
    p_ndi_name: 'str', p_groups: 'str', clock_video: 'bool', clock_audio: 'bool',
  });

  const T = { source: NDIlib_source_t, video: NDIlib_video_frame_v2_t, audio: NDIlib_audio_frame_v3_t,
    sendCreate: NDIlib_send_create_t, recvQueue: NDIlib_recv_queue_t };

  const F = {
    init: lib.func('bool NDIlib_initialize()'),
    is_supported_cpu: lib.func('bool NDIlib_is_supported_CPU()'),
    find_create: lib.func('void* NDIlib_find_create_v2(NDIlib_find_create_t* p)'),
    find_wait: lib.func('bool NDIlib_find_wait_for_sources(void* p, uint32_t ms)'),
    find_sources: lib.func('void* NDIlib_find_get_current_sources(void* p, _Out_ uint32_t* n)'),
    find_destroy: lib.func('void NDIlib_find_destroy(void* p)'),
    recv_create: lib.func('void* NDIlib_recv_create_v3(NDIlib_recv_create_v3_t* p)'),
    recv_capture: lib.func('int NDIlib_recv_capture_v3(void* p, _Out_ NDIlib_video_frame_v2_t* v, _Out_ NDIlib_audio_frame_v3_t* a, void* m, uint32_t ms)'),
    recv_free_video: lib.func('void NDIlib_recv_free_video_v2(void* p, NDIlib_video_frame_v2_t* v)'),
    recv_free_audio: lib.func('void NDIlib_recv_free_audio_v3(void* p, NDIlib_audio_frame_v3_t* a)'),
    recv_destroy: lib.func('void NDIlib_recv_destroy(void* p)'),
    recv_get_no_connections: lib.func('int NDIlib_recv_get_no_connections(void* p, uint32_t ms)'),
    // How much the SDK still has waiting for us. recv_capture hands back the
    // OLDEST queued frame, so this is what tells a receiver that the picture it
    // is holding has already been superseded. Present from NDI 4 on; callers
    // must tolerate it being missing on an ancient runtime.
    recv_get_queue: (() => {
      try { return lib.func('void NDIlib_recv_get_queue(void* p, _Out_ NDIlib_recv_queue_t* q)'); }
      catch (e) { return null; }
    })(),
    // --- sending (the Presentation Studio publishes its outputs over NDI) ---
    send_create: lib.func('void* NDIlib_send_create(NDIlib_send_create_t* p)'),
    send_destroy: lib.func('void NDIlib_send_destroy(void* p)'),
    send_video: lib.func('void NDIlib_send_send_video_v2(void* p, NDIlib_video_frame_v2_t* v)'),
    // Hands the frame over and returns before it has been compressed, so the
    // SDK's own threads do that work instead of the one thread that is also
    // meant to be collecting the next frame. The buffer must stay alive until
    // the call AFTER next — see ndi-send-worker.js, which holds two.
    send_video_async: (() => {
      try { return lib.func('void NDIlib_send_send_video_async_v2(void* p, NDIlib_video_frame_v2_t* v)'); }
      catch (e) { return null; }
    })(),
    send_audio: lib.func('void NDIlib_send_send_audio_v3(void* p, NDIlib_audio_frame_v3_t* a)'),
    send_get_no_connections: lib.func('int NDIlib_send_get_no_connections(void* p, uint32_t ms)'),
  };

  // Cache koffi array types by element type + length so the capture loop doesn't
  // churn koffi's type table (resolution rarely changes, so this stays tiny).
  const arrCache = new Map();
  function arrType(type, len) {
    const key = type + ':' + len;
    let t = arrCache.get(key);
    if (!t) { t = koffi.array(type, len, 'Typed'); arrCache.set(key, t); }
    return t;
  }

  return { koffi, lib, T, F, arrType };
}

module.exports = { loadNdi };
