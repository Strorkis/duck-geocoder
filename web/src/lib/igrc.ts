/**
 * **SORA 2.5 の地上リスク (iGRC)** の表。人口密度の凡例の区切りに使う。
 * 画面にも地図にも依存しない。
 */

/** 機体の区分。SORA 2.5 の iGRC 表の列。 */
export const AIRCRAFT_CLASSES = [
  { label: '1m / 25m/s', dimension: '1m' },
  { label: '3m / 35m/s', dimension: '3m' },
  { label: '8m / 75m/s', dimension: '8m' },
  { label: '20m / 120m/s', dimension: '20m' },
  { label: '40m / 200m/s', dimension: '40m' },
];

/**
 * SORA 2.5 の iGRC 表 (JARUS JAR_doc_25 Table 2) の、人口密度の行。
 *
 * **色の区切りをこの表に合わせる。** 連続的なグラデーションだと「濃い/薄い」しか
 * 読めないが、判断の区切りで段を切れば、地図がそのまま iGRC を答える。
 *
 * `igrc` は [`AIRCRAFT_CLASSES`] と同じ並び。`null` は**SORAの適用範囲外**。
 *
 * 表の写しなので、**運用に使う前に原文を確認すること。**
 * <http://jarus-rpas.org/wp-content/uploads/2024/06/SORA-v2.5-Main-Body-Release-JAR_doc_25.pdf>
 */
export const IGRC_BANDS: {
  /** この帯の上限 (人/km²)。未満ならこの帯。 */
  limit: number;
  label: string;
  color: string;
  igrc: (number | null)[];
}[] = [
  { limit: 5, label: '5 未満', color: '#ffffb2', igrc: [2, 3, 4, 5, 6] },
  { limit: 50, label: '5 〜 50', color: '#fed976', igrc: [3, 4, 5, 6, 7] },
  { limit: 500, label: '50 〜 500', color: '#feb24c', igrc: [4, 5, 6, 7, 8] },
  { limit: 5000, label: '500 〜 5,000', color: '#fd8d3c', igrc: [5, 6, 7, 8, 9] },
  { limit: 50000, label: '5,000 〜 50,000', color: '#f03b20', igrc: [6, 7, 8, 9, 10] },
  {
    limit: Number.POSITIVE_INFINITY,
    label: '50,000 超',
    color: '#bd0026',
    igrc: [7, 8, null, null, null],
  },
];

/** 人口密度 (人/km²) から iGRC の帯を引く。 */
export function igrcBand(density: number) {
  return IGRC_BANDS.find((band) => density < band.limit) ?? IGRC_BANDS[IGRC_BANDS.length - 1];
}
