/**
 * Writes the real length of a recording into the WebM it came from.
 *
 * MediaRecorder muxes live, so it emits a Segment of unknown size with no
 * Duration and no Cues: the file plays, but every player reports its duration
 * as Infinity and cannot seek. The usual workaround is to ask the player to
 * seek past the end and let it discover the length, which is exactly what left
 * Casrion's voice memos looking permanently disabled — that absurd seek turns
 * into a read past the end of the file, and Chromium treats a failed read as a
 * fatal pipeline error and kills the player for good.
 *
 * The recorder knows how long it ran, so the honest fix is to put that number
 * in the file: one Duration element inside Info. After this the player knows
 * the length from the first bytes it reads, no seek trick required.
 *
 * Anything unexpected in the file means the buffer comes back untouched: a
 * memo that plays without a duration beats a memo corrupted by a clever patch.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_CUES = 0x1c53bb6b;
const ID_CLUSTER = 0x1f43b675;

// An EBML id or size is a variable length integer whose first byte says how
// many bytes it spans: the number of leading zero bits before the first 1.
function vintLength(first) {
  if (first === undefined) return 0;
  for (let len = 1; len <= 8; len++) {
    if (first & (0x80 >> (len - 1))) return len;
  }
  return 0; // 0x00: not a valid start byte
}

// Element ids keep their marker bit (that is how they are written down).
function readId(buf, pos) {
  const len = vintLength(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

// Sizes drop the marker bit. An all-ones payload means "size unknown", which
// is how a live muxer writes a Segment or Cluster it is still filling.
function readSize(buf, pos) {
  const len = vintLength(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  const mask = (1 << (8 - len)) - 1;
  let value = buf[pos] & mask;
  let unknown = value === mask;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function sizeVintLength(value) {
  for (let len = 1; len <= 8; len++) {
    // The all-ones pattern is reserved for "unknown", so it is not usable
    if (value < Math.pow(2, 7 * len) - 1) return len;
  }
  return 0;
}

function writeSizeVint(value, len) {
  const out = Buffer.alloc(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}

// Walk one level of children, stopping at the first element the caller wants.
function findChild(buf, start, end, wantedId, stopIds) {
  let pos = start;
  while (pos < end) {
    const id = readId(buf, pos);
    if (!id) return null;
    const size = readSize(buf, pos + id.len);
    if (!size) return null;
    const bodyStart = pos + id.len + size.len;
    if (id.id === wantedId) return { start: pos, bodyStart, size, idLen: id.len };
    if (stopIds && stopIds.includes(id.id)) return null;
    if (size.unknown) return null; // cannot skip an element of unknown length
    pos = bodyStart + size.value;
    if (pos <= bodyStart && size.value !== 0) return null; // no forward progress
  }
  return null;
}

/**
 * @param {Buffer} buffer  raw MediaRecorder output
 * @param {number} durationMs  how long the recorder actually ran
 * @returns {Buffer} the same bytes with a Duration written in, or the original
 */
function patchWebmDuration(buffer, durationMs) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64) return buffer;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return buffer;

    // EBML header first, then the Segment that holds everything else
    const header = readId(buffer, 0);
    if (!header || header.id !== ID_EBML) return buffer;
    const headerSize = readSize(buffer, header.len);
    if (!headerSize || headerSize.unknown) return buffer;

    const segStart = header.len + headerSize.len + headerSize.value;
    const segment = readId(buffer, segStart);
    if (!segment || segment.id !== ID_SEGMENT) return buffer;
    const segSize = readSize(buffer, segStart + segment.len);
    if (!segSize) return buffer;
    const segBody = segStart + segment.len + segSize.len;

    // A SeekHead or Cues stores absolute byte offsets into the segment, and
    // inserting bytes ahead of them would silently point them at the wrong
    // place. A live MediaRecorder writes neither, so bail rather than gamble.
    const info = findChild(buffer, segBody, buffer.length, ID_INFO, [ID_SEEK_HEAD, ID_CUES, ID_CLUSTER]);
    if (!info || info.size.unknown) return buffer;
    const infoEnd = info.bodyStart + info.size.value;
    if (infoEnd > buffer.length) return buffer;

    // Duration counts in TimecodeScale units (nanoseconds per tick, 1ms by default)
    let scaleNs = 1000000;
    const scale = findChild(buffer, info.bodyStart, infoEnd, ID_TIMECODE_SCALE, null);
    if (scale && !scale.size.unknown && scale.size.value > 0 && scale.size.value <= 8) {
      let v = 0;
      for (let i = 0; i < scale.size.value; i++) v = v * 256 + buffer[scale.bodyStart + i];
      if (v > 0) scaleNs = v;
    }
    const ticks = (durationMs * 1000000) / scaleNs;
    if (!Number.isFinite(ticks) || ticks <= 0) return buffer;

    // Already has a Duration (some builds write a zero placeholder): overwrite
    // it where it lies, which changes no sizes at all.
    const existing = findChild(buffer, info.bodyStart, infoEnd, ID_DURATION, null);
    if (existing && !existing.size.unknown) {
      if (existing.size.value === 8) {
        const out = Buffer.from(buffer);
        out.writeDoubleBE(ticks, existing.bodyStart);
        return out;
      }
      if (existing.size.value === 4) {
        const out = Buffer.from(buffer);
        out.writeFloatBE(ticks, existing.bodyStart);
        return out;
      }
      return buffer; // an odd width: leave it alone
    }

    // Otherwise append one to Info: id (2) + size (1) + a 64-bit float (8)
    const element = Buffer.alloc(11);
    element.writeUInt16BE(ID_DURATION, 0);
    element[2] = 0x88; // size vint for 8
    element.writeDoubleBE(ticks, 3);

    const newInfoSize = info.size.value + element.length;
    const newSizeLen = sizeVintLength(newInfoSize);
    if (!newSizeLen || newSizeLen < info.size.len) return buffer;
    const newInfoSizeVint = writeSizeVint(newInfoSize, Math.max(newSizeLen, info.size.len));

    // The Segment is written with an unknown size while recording, so it needs
    // no adjusting. If some other muxer gave it a real size, only grow it when
    // the length of that number does not change (otherwise offsets shift again).
    let segmentPatch = null;
    if (!segSize.unknown) {
      const grown = segSize.value + element.length + (newInfoSizeVint.length - info.size.len);
      if (sizeVintLength(grown) !== segSize.len) return buffer;
      segmentPatch = { at: segStart + segment.len, vint: writeSizeVint(grown, segSize.len) };
    }

    const out = Buffer.concat([
      buffer.subarray(0, info.start + info.idLen),   // everything up to Info's size
      newInfoSizeVint,                               // Info's new size
      buffer.subarray(info.bodyStart, infoEnd),      // Info's existing children
      element,                                       // the Duration
      buffer.subarray(infoEnd)                       // Tracks, Clusters, the audio
    ]);
    if (segmentPatch) segmentPatch.vint.copy(out, segmentPatch.at);
    return out;
  } catch {
    // Never let a malformed header cost the user their recording
    return buffer;
  }
}

module.exports = { patchWebmDuration };
