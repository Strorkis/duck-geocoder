/**
 * **表示量。** 上限とズームの閾値だけを動かす — 何をどう読むかは変えない。
 *
 * どこまで描けるかは端末で違うので、利用者が決められるようにする。
 * 数字を直接触らせず3段にしているのは、上限を3000にするか4000にするかを
 * 決める材料が利用者の側に無いため。**上限に当たったことは各レイヤーが
 * 「表示上限」と断る**ので、そこを見て段を上げればよい。
 */
export type DetailLevel = 'low' | 'medium' | 'high';

export interface DetailSettings {
  /** 建物が原寸に切り替わるズーム。これより引くと整備範囲を出す。 */
  buildingsMinZoom: number;
  buildingsLimit: number;
  railwayLimit: number;
  roadLimit: number;
  /**
   * 道路の等級ごとの最小ズームから**引く**値。大きいほど引いた表示で
   * 多くの等級が出る。高速は元が0なので動かない。
   */
  roadClassZoomShift: number;
}

/**
 * **標準は従来の値と完全に一致させる。** 転送量や件数を測っている
 * E2Eの基準がこれで決まっているため、既定を動かすとそちらも動く。
 *
 * 多めは建物を1ズーム早く、道路の等級を2ズーム早く、鉄道と道路の上限を2倍。
 * 控えめはその逆。**建物のズームを1より大きく動かさない** —
 * 14で原寸の1画面は15の4倍の面積で、ズーム13の東京駅は21万棟 (実測) ある。
 *
 * **多めの建物の上限は4万。** ズーム14の東京駅は1280×720の画面で3.7万棟あり、
 * 6,000では中心の2割弱しか出なかった。上限は**転送量を減らさない** —
 * 中心から近い順に並べてから切るので、並べるために画面内を全部読む
 * (実測: 上限6,000でも6万でも37.5MB)。6万で37,178棟を描いても5.6秒で、
 * 6,000件のとき (7.0秒) と変わらなかった。1920×1080だと11.9万棟あるが、
 * そこまで描くのは測っていないので上げない。
 */
export const DETAIL_LEVELS: Record<DetailLevel, DetailSettings & { label: string }> = {
  low: {
    label: '控えめ',
    buildingsMinZoom: 16,
    buildingsLimit: 1500,
    railwayLimit: 2000,
    roadLimit: 3000,
    roadClassZoomShift: -2,
  },
  medium: {
    label: '標準',
    buildingsMinZoom: 15,
    buildingsLimit: 3000,
    railwayLimit: 4000,
    roadLimit: 6000,
    roadClassZoomShift: 0,
  },
  high: {
    label: '多め',
    buildingsMinZoom: 14,
    buildingsLimit: 40000,
    railwayLimit: 8000,
    roadLimit: 12000,
    roadClassZoomShift: 2,
  },
};

const DETAIL_STORAGE_KEY = 'duck-geocoder:detail';

/**
 * 保存されている段。無い・読めない・知らない値なら標準。
 *
 * **表示量だけは端末に覚える。** どこまで描けるかは端末の性能で決まり、
 * 開くたびに選び直させる理由が無い (一覧の中身は覚えない。そちらは読み直せば既定に戻る)。
 */
export function loadDetailLevel(): DetailLevel {
  try {
    const saved = localStorage.getItem(DETAIL_STORAGE_KEY);
    if (saved && saved in DETAIL_LEVELS) return saved as DetailLevel;
  } catch {
    // プライベートブラウズなどで localStorage が使えないことがある。
    // 覚えられないだけで表示はできるので、黙って標準にする。
  }
  return 'medium';
}

export function saveDetailLevel(level: DetailLevel): void {
  try {
    localStorage.setItem(DETAIL_STORAGE_KEY, level);
  } catch {
    // 同上。覚えられなくても今の表示には効いている。
  }
}
