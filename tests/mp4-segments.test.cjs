const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareMp4, createMediaManifest } = require('../apps/web/src/mp4-segments.ts');
const { validateControlMessage } = require('../packages/protocol/control-validator.ts');

test('rejects empty and invalid media', async () => {
  await assert.rejects(prepareMp4(new Blob()), /smaller than 256 MB/);
  await assert.rejects(
    prepareMp4(new Blob(['not an MP4']), { supportsType: () => true }),
    /No playable media segments/,
  );
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
  for (const track of media.tracks) {
    const trackChunks = media.chunks.filter((chunk) => chunk.trackId === track.id);
    assert.equal(trackChunks[0].kind, 'init');
    assert.ok(trackChunks.some((chunk) => chunk.kind === 'media'));
    assert.ok(trackChunks.every((chunk) => media.readChunk(chunk.chunkIndex)?.byteLength === chunk.byteLength));
    const outputPath = path.join(directory, `${track.kind}.mp4`);
    fs.writeFileSync(outputPath, Buffer.concat(trackChunks.map((chunk) => media.readChunk(chunk.chunkIndex))));
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), track.kind);
  }
  assert.equal(media.readChunk(media.chunks.length), null);
});
