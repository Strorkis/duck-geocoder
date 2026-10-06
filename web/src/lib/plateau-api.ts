/**
 * **PLATEAU配信サービス (公式のAPI)** で、CityGML のメッシュ単位のファイルと pack を引く。
 * 画面にも地図にも依存しない。
 *
 * このAPIはブラウザから直接呼べる (`access-control-allow-origin: *` を確かめた)。
 * **呼ぶのは利用者が押したときだけ** (起動時には呼ばない。配信サービスに負荷をかけない)。
 */
import { m } from '../i18n';

const PLATEAU_API = 'https://api.plateauview.mlit.go.jp';

/** CityGMLの地物の種類の呼び名。APIが返す種類のうち、よく出るもの。 */
export const CITYGML_TYPES: Readonly<Record<string, string>> = m.citygmlTypes;

/** メッシュ単位のCityGMLファイル1つ。 */
export interface CityGmlFile {
  type: string;
  code: string;
  url: string;
  maxLod: number;
  fileSize?: number;
  features?: number;
}

/** 表示範囲のCityGMLファイル (メッシュ単位) を引く。`codes` は地域メッシュのコード。 */
export async function fetchCityGmlFiles(codes: string[]): Promise<CityGmlFile[]> {
  const response = await fetch(`${PLATEAU_API}/datacatalog/citygml/m:${codes.join(',')}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`PLATEAU配信サービスが ${response.status} を返しました`);
  const body = (await response.json()) as {
    cities?: { files?: Record<string, Omit<CityGmlFile, 'type'>[]> }[];
  };
  const files: CityGmlFile[] = [];
  const seen = new Set<string>();
  for (const city of body.cities ?? []) {
    for (const [type, list] of Object.entries(city.files ?? {})) {
      for (const file of list) {
        if (!file.url || seen.has(file.url)) continue;
        seen.add(file.url);
        files.push({ ...file, type });
      }
    }
  }
  return files;
}

/**
 * 公式の pack で、選んだCityGMLを**付属ファイル (コードリスト・テクスチャ) 込みのZIP**に
 * まとめてもらう。サーバー側の非同期の処理なので、状態を数秒おきに見る。
 * 返すのはZIPのURL。
 */
export async function packCityGml(urls: string[], onProgress: (progress: number) => void): Promise<string> {
  const response = await fetch(`${PLATEAU_API}/citygml/pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  if (!response.ok) throw new Error(`packの依頼に失敗しました (${response.status})`);
  const { id } = (await response.json()) as { id: string };
  for (;;) {
    const status = await fetch(`${PLATEAU_API}/citygml/pack/${id}/status`);
    if (!status.ok) throw new Error(`packの状態を取れません (${status.status})`);
    const body = (await status.json()) as { status: string; progress?: number };
    if (body.status === 'succeeded') return `${PLATEAU_API}/citygml/pack/${id}.zip`;
    if (body.status !== 'accepted' && body.status !== 'processing') {
      throw new Error(`packが失敗しました (${body.status})`);
    }
    onProgress(body.progress ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
