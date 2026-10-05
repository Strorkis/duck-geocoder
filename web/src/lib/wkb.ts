/**
 * **WKB を GeoJSON のジオメトリに読む。** 画面にも地図にも依存しない (import も無い —
 * `node --test` でそのまま試せるように)。
 *
 * DuckDB-WASM は GEOMETRY の列を Arrow で返すとき **GeoArrow (`geoarrow.wkb`)** にする。
 * 以前は SQL の `ST_AsGeoJSON` で文字列にしてから `JSON.parse` していたが、文字列を作る・
 * 解くの両方が要らなくなる (東京駅付近の建物 2.8万棟で、問い合わせが 245ms → 160ms)。
 *
 * 読むのは2次元だけ。Z・M を持つもの (ISO の 1000番台・2000番台・3000番台と、EWKB の旗) は
 * 座標を読み飛ばす (地図は平面に描くので使わない)。
 */

/** WKB の型の番号 (2次元のとき)。 */
const POINT = 1;
const LINE_STRING = 2;
const POLYGON = 3;
const MULTI_POINT = 4;
const MULTI_LINE_STRING = 5;
const MULTI_POLYGON = 6;
const GEOMETRY_COLLECTION = 7;

/** EWKB (PostGIS) の旗。DuckDB は ISO で書くが、外から来たものに備えて読む。 */
const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

class Reader {
  private offset = 0;
  private little = true;
  private readonly view: DataView;

  // 引数のプロパティ宣言 (`constructor(private …)`) は使わない (erasableSyntaxOnly)。
  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  geometry(): GeoJSON.Geometry {
    this.little = this.view.getUint8(this.offset) === 1;
    this.offset += 1;
    let code = this.uint32();
    let dims = 2;
    if (code & (EWKB_Z | EWKB_M | EWKB_SRID)) {
      if (code & EWKB_Z) dims++;
      if (code & EWKB_M) dims++;
      if (code & EWKB_SRID) this.offset += 4;
      code &= 0x0fffffff;
    } else if (code >= 1000) {
      // ISO: 1000番台 = Z、2000番台 = M、3000番台 = ZM。
      const extra = Math.floor(code / 1000);
      dims += extra === 3 ? 2 : 1;
      code %= 1000;
    }
    switch (code) {
      case POINT: {
        const coordinates = this.position(dims);
        // 空の点は NaN で書かれる。GeoJSON では座標の無い点になる。
        return { type: 'Point', coordinates: Number.isNaN(coordinates[0]) ? [] : coordinates };
      }
      case LINE_STRING:
        return { type: 'LineString', coordinates: this.positions(dims) };
      case POLYGON:
        return { type: 'Polygon', coordinates: this.rings(dims) };
      case MULTI_POINT:
        return { type: 'MultiPoint', coordinates: this.parts(() => (this.geometry() as GeoJSON.Point).coordinates) };
      case MULTI_LINE_STRING:
        return {
          type: 'MultiLineString',
          coordinates: this.parts(() => (this.geometry() as GeoJSON.LineString).coordinates),
        };
      case MULTI_POLYGON:
        return {
          type: 'MultiPolygon',
          coordinates: this.parts(() => (this.geometry() as GeoJSON.Polygon).coordinates),
        };
      case GEOMETRY_COLLECTION:
        return { type: 'GeometryCollection', geometries: this.parts(() => this.geometry()) };
      default:
        throw new Error(`WKB の型 ${code} は読めません`);
    }
  }

  private uint32(): number {
    const value = this.view.getUint32(this.offset, this.little);
    this.offset += 4;
    return value;
  }

  private position(dims: number): GeoJSON.Position {
    const x = this.view.getFloat64(this.offset, this.little);
    const y = this.view.getFloat64(this.offset + 8, this.little);
    this.offset += 8 * dims;
    return [x, y];
  }

  private positions(dims: number): GeoJSON.Position[] {
    const count = this.uint32();
    const out = new Array<GeoJSON.Position>(count);
    for (let i = 0; i < count; i++) out[i] = this.position(dims);
    return out;
  }

  private rings(dims: number): GeoJSON.Position[][] {
    const count = this.uint32();
    const out = new Array<GeoJSON.Position[]>(count);
    for (let i = 0; i < count; i++) out[i] = this.positions(dims);
    return out;
  }

  /** Multi* と GeometryCollection の中身。**中の1つずつがバイト順と型を持つ** (WKB の決まり)。 */
  private parts<T>(read: () => T): T[] {
    const count = this.uint32();
    const out = new Array<T>(count);
    for (let i = 0; i < count; i++) out[i] = read();
    return out;
  }
}

/** WKB のバイト列を GeoJSON のジオメトリにする。 */
export function parseWkb(bytes: Uint8Array): GeoJSON.Geometry {
  return new Reader(bytes).geometry();
}

/**
 * DuckDB の結果の値 (ジオメトリの列。GeoArrow の WKB) を GeoJSON にする。
 * **SQL ではジオメトリの列をそのまま返す** (`SELECT geometry …`)。計算したジオメトリ
 * (`ST_Intersection` など) も GEOMETRY 型なので同じく返せる。
 */
export function geometryOf(value: unknown): GeoJSON.Geometry {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`ジオメトリが WKB で返っていません (${Object.prototype.toString.call(value)})`);
  }
  return parseWkb(value);
}
