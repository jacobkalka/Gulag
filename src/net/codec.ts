// Minimal little-endian binary writer/reader for the unreliable data channel.

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  off = 0;

  constructor(size = 512) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes);
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.off, v);
    this.off += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.off, Math.max(-128, Math.min(127, Math.round(v))));
    this.off += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.off, Math.max(0, Math.min(65535, Math.round(v))), true);
    this.off += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.off, Math.max(-32768, Math.min(32767, Math.round(v))), true);
    this.off += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
    return this;
  }
  /** Unsigned value quantized to a byte over [0, max]. */
  q8(v: number, max: number): this {
    return this.u8(Math.max(0, Math.min(255, Math.round((v / max) * 255))));
  }
  str(s: string): this {
    const b = enc.encode(s).subarray(0, 255);
    this.u8(b.length);
    this.ensure(b.length);
    this.bytes.set(b, this.off);
    this.off += b.length;
    return this;
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.off);
  }
}

export class ByteReader {
  private view: DataView;
  private bytes: Uint8Array;
  off = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.off;
  }

  private need(n: number): void {
    if (this.off + n > this.bytes.byteLength) throw new RangeError('packet truncated');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.off++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.off++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }
  q8(max: number): number {
    return (this.u8() / 255) * max;
  }
  str(): string {
    const n = this.u8();
    this.need(n);
    const s = dec.decode(this.bytes.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}
