const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private buffered = 0;
  private totalBytes = 0;

  update(input: Uint8Array): this {
    this.totalBytes += input.byteLength;
    let offset = 0;
    while (offset < input.length) {
      const copyLength = Math.min(64 - this.buffered, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + copyLength), this.buffered);
      this.buffered += copyLength;
      offset += copyLength;
      if (this.buffered === 64) {
        this.compress(this.buffer);
        this.buffered = 0;
      }
    }
    return this;
  }

  digest(): string {
    const bitLength = this.totalBytes * 8;
    this.buffer[this.buffered] = 0x80;
    this.buffered += 1;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered);
      this.compress(this.buffer);
      this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    this.buffer[56] = high >>> 24;
    this.buffer[57] = high >>> 16;
    this.buffer[58] = high >>> 8;
    this.buffer[59] = high;
    this.buffer[60] = low >>> 24;
    this.buffer[61] = low >>> 16;
    this.buffer[62] = low >>> 8;
    this.buffer[63] = low;
    this.compress(this.buffer);

    const output = new Uint8Array(32);
    this.state.forEach((value, index) => {
      output[index * 4] = value >>> 24;
      output[index * 4 + 1] = value >>> 16;
      output[index * 4 + 2] = value >>> 8;
      output[index * 4 + 3] = value;
    });
    return hex(output);
  }

  private compress(chunk: Uint8Array): void {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] = (chunk[offset] << 24) | (chunk[offset + 1] << 16) | (chunk[offset + 2] << 8) | chunk[offset + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export async function hashStream(stream: ReadableStream<Uint8Array> | null): Promise<{ sha256: string; size: number }> {
  if (!stream) return { sha256: new Sha256().digest(), size: 0 };
  const reader = stream.getReader();
  const hash = new Sha256();
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    hash.update(result.value);
    size += result.value.byteLength;
  }
  return { sha256: hash.digest(), size };
}
