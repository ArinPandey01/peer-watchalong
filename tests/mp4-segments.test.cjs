const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareMp4, createMediaManifest, createMediaWindow, hashMediaWindow } = require('../apps/web/src/mp4-segments.ts');
const { decodeMediaBundle, encodeMediaBundle } = require('../apps/web/src/media-bundle.ts');
const { validateControlMessage } = require('../packages/protocol/control-validator.ts');

test('rejects empty and invalid media', async () => {
  await assert.rejects(prepareMp4(new Blob()), /smaller than 256 MB/);
  await assert.rejects(
    prepareMp4(new Blob(['not an MP4']), { supportsType: () => true }),
    /No playable media segments/,
  );
});

test('media bundles reject altered part lengths', () => {
  const data = encodeMediaBundle([
    { trackId: 1, data: Uint8Array.of(1, 2) },
    { trackId: 2, data: Uint8Array.of(3) },
  ]);
  assert.deepEqual([...decodeMediaBundle(data, [
    { trackId: 1, byteLength: 2 }, { trackId: 2, byteLength: 1 },
  ])], [[1, Uint8Array.of(1, 2)], [2, Uint8Array.of(3)]]);
  assert.throws(() => decodeMediaBundle(data, [
    { trackId: 1, byteLength: 1 }, { trackId: 2, byteLength: 1 },
  ]), /Invalid media bundle part/);
});

test('prepares playable video and audio segments from an MP4', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchalong-mp4-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.mp4');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-movflags', '+faststart', '-y', sourcePath,
  ], { encoding: 'utf8' });
  if (generated.status !== 0) {
    t.skip('ffmpeg with H.264 and AAC encoders is required for this integration test');
    return;
  }

  const media = await prepareMp4(new Blob([fs.readFileSync(sourcePath)]), {
    supportsType: () => true,
  });
  const manifest = await createMediaManifest(media, 'media-1');
  assert.equal(manifest.chunks.length, media.chunks.length);
  assert.ok(manifest.chunks.every((chunk) => /^[0-9a-f]{64}$/.test(chunk.sha256)));
  assert.doesNotThrow(() => validateControlMessage({
    version: 1, type: 'MEDIA_SET_REQ', messageId: 'media', sessionId: 'room',
    senderId: 'host', timestamp: 1000, payload: { manifest },
  }));
  assert.equal(media.tracks.length, 2);
  assert.ok(media.durationSec >= 5);
  assert.equal(media.chunks.filter((chunk) => chunk.kind === 'init').length, 2);
  const bundles = media.chunks.filter((chunk) => chunk.kind === 'media');
  assert.ok(bundles.every((chunk) => chunk.parts.some((part) =>
    part.trackId === media.tracks.find((track) => track.kind === 'video').id)));
  assert.ok(bundles.some((chunk) => chunk.parts.length === 2));
  for (const track of media.tracks) {
    const init = media.chunks.find((chunk) => chunk.kind === 'init' && chunk.trackId === track.id);
    assert.ok(init);
    const trackChunks = [media.readChunk(init.chunkIndex), ...bundles.flatMap((chunk) => {
      const data = media.readChunk(chunk.chunkIndex);
      assert.equal(data.byteLength, chunk.byteLength);
      const part = decodeMediaBundle(data, chunk.parts).get(track.id);
      return part ? [part] : [];
    })];
    assert.ok(trackChunks.length > 1);
    const outputPath = path.join(directory, `${track.kind}.mp4`);
    fs.writeFileSync(outputPath, Buffer.concat(trackChunks));
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), track.kind);
  }
  assert.equal(media.readChunk(media.chunks.length), null);
});

test('prepares segments when MP4 metadata follows the media data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchalong-tail-moov-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'tail-moov.mp4');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-y', sourcePath,
  ], { encoding: 'utf8' });
  if (generated.status !== 0) {
    t.skip('ffmpeg with H.264 and AAC encoders is required for this integration test');
    return;
  }

  const data = fs.readFileSync(sourcePath);
  assert.ok(data.indexOf('mdat') < data.indexOf('moov'));
  const media = await prepareMp4(new Blob([data]), { supportsType: () => true });
  assert.equal(media.tracks.length, 2);
  assert.ok(media.chunks.some((chunk) => chunk.kind === 'media' &&
    chunk.parts.some((part) => part.trackId === media.tracks[0].id)));
  assert.ok(media.chunks.some((chunk) => chunk.kind === 'media' &&
    chunk.parts.some((part) => part.trackId === media.tracks[1].id)));
});

test('publishes a bounded metadata window for a video with hundreds of chunks', async () => {
  const chunks = [
    { chunkIndex: 0, trackId: 1, kind: 'init', startTimeSec: 0, endTimeSec: 0,
      byteLength: 1, sha256: '0'.repeat(64) },
    ...Array.from({ length: 700 }, (_, index) => ({
      chunkIndex: index + 1, trackId: 1, kind: 'media',
      startTimeSec: index * 2, endTimeSec: (index + 1) * 2,
      byteLength: 1, sha256: '1'.repeat(64),
    })),
  ];
  const full = {
    mediaId: 'long-video', durationSec: 1400,
    tracks: [{ id: 1, kind: 'video', mimeType: 'video/mp4; codecs="avc1.64000a"' }],
    chunks,
  };
  const prepared = {
    durationSec: full.durationSec,
    tracks: full.tracks,
    chunks: chunks.map(({ sha256, ...chunk }) => chunk),
    readChunk: () => Uint8Array.of(1),
  };
  const completeManifest = await createMediaManifest(prepared, full.mediaId);
  assert.equal(completeManifest.chunks.length, 701);
  for (const target of [0, 600, 1390]) {
    const window = createMediaWindow(completeManifest, target);
    assert.equal(window.totalChunks, 701);
    assert.ok(window.chunks.length < 30);
    assert.ok(window.chunks.some((chunk) =>
      chunk.kind === 'media' && chunk.startTimeSec <= target && chunk.endTimeSec > target));
    assert.doesNotThrow(() => validateControlMessage({
      version: 1, type: 'MEDIA_SET_REQ', messageId: 'media', sessionId: 'room',
      senderId: 'host', timestamp: 1000, payload: { manifest: window },
    }));
  }
  let reads = 0;
  const firstWindow = createMediaWindow(full, 0);
  const hashed = await hashMediaWindow({ ...prepared, readChunk: () => {
    reads++;
    return Uint8Array.of(1);
  } }, firstWindow, new Map());
  assert.equal(reads, firstWindow.chunks.length);
  assert.ok(hashed.chunks.every((chunk) => chunk.sha256 !== '0'.repeat(64)));
});
