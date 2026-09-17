//! 国勢調査の地域メッシュ統計 (e-Stat 統計GIS) を読む。
//!
//! ジオメトリはメッシュコードから計算する ([`crate::mesh`])。境界データを
//! 落とさないので、測量法の懸念が原理的に発生しない。
//!
//! 配布されるのはShift-JISのCSVで、**ヘッダが2行ある**。
//!
//! ```text
//! KEY_CODE,HTKSYORI,HTKSAKI,GASSAN,T001231001,T001231002,...
//! ,,,,　人口（総数）,　人口（総数）　男,...
//! 36533758112,0,,,9,9,...
//! ```
//!
//! 1行目が項目コード、2行目が項目名。**項目コードは調査年や統計表で変わる**
//! (`T001231001` は令和2年の6次メッシュ用) ので、**項目名で引く**。

use crate::geoparquet;
use crate::mesh;
use anyhow::{Context, Result, bail};
use geo_traits::CoordTrait;
use geo_types::Polygon;
use std::collections::BTreeMap;
use std::path::Path;

/// 人口の列を指す項目名。先頭に全角空白が付くので `trim` して比べる。
const POPULATION: &str = "人口（総数）";
/// 世帯数の列を指す項目名。
const HOUSEHOLDS: &str = "世帯総数";

/// メッシュ1件分。
#[derive(Debug)]
pub struct Row {
    /// メッシュコード。桁数がそのまま細かさを表す (11桁なら125m)。
    pub mesh_code: String,
    /// 人口 (総数)。
    pub population: Option<i32>,
    /// 世帯数 (総数)。
    pub households: Option<i32>,
    /// **このメッシュが代表する最大の人口密度 (人/km²)。**
    /// SORAのGround Riskが見るのはこれ。
    ///
    /// 125mメッシュでは、そのメッシュ自身の密度 (人口 ÷ 面積)。
    /// [`aggregate`] で束ねたメッシュでは、**中に含まれる125mメッシュの最大値**。
    ///
    /// 平均にしないのは、SORAが運航範囲の中で最も密度の高いところを採るため。
    /// 束ねるときに平均すると、危ないセルが薄まって消える。
    ///
    /// メッシュの面積は緯度で変わるので、コードごとに計算した面積で割る。
    pub density: Option<f64>,
    /// メッシュの矩形。コードから計算したもの。
    pub geometry: Polygon<f64>,
}

/// 2行目の項目名から、欲しい列の位置を探す。
///
/// **見つからなければ項目名を並べてエラーにする。** 統計表が変われば項目名も
/// 変わりうるので、黙って別の列を拾うより、何があるかを見せて落とす方がよい。
fn column_index(names: &csv::StringRecord, wanted: &str) -> Result<usize> {
    names
        .iter()
        .position(|name| name.trim() == wanted)
        .with_context(|| {
            let available: Vec<&str> = names
                .iter()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .collect();
            format!("項目「{wanted}」がありません。この統計表にあるのは: {available:?}")
        })
}

/// 数値の欄を読む。秘匿 (`*`) や該当なし (`-`)、空欄は None にする。
fn number(field: &str) -> Option<i32> {
    field.trim().parse().ok()
}

/// 地域メッシュ統計のCSV (UTF-8に変換済み) をパースする。
pub fn parse_csv(csv_text: &str) -> Result<Vec<Row>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(csv_text.as_bytes());
    let mut records = reader.records();

    let codes = records
        .next()
        .context("1行目 (項目コード) がありません")?
        .context("1行目を読めません")?;
    if codes.get(0).map(str::trim) != Some("KEY_CODE") {
        bail!(
            "1列目が KEY_CODE ではありません: {:?} (統計データではなく境界データを落としていませんか)",
            codes.get(0)
        );
    }
    let names = records
        .next()
        .context("2行目 (項目名) がありません")?
        .context("2行目を読めません")?;

    let population_at = column_index(&names, POPULATION)?;
    let households_at = column_index(&names, HOUSEHOLDS)?;

    let mut rows = Vec::new();
    for record in records {
        let record = record.context("行を読めません")?;
        let mesh_code = record.get(0).unwrap_or_default().trim().to_string();
        if mesh_code.is_empty() {
            continue;
        }

        // ジオメトリと面積はコードから計算する。読めないコードはエラーにする
        // (黙って飛ばすと、人口の合計が合わないのに気づけない)。
        let geometry = mesh::polygon(&mesh_code)
            .with_context(|| format!("メッシュコードを解釈できません: {mesh_code}"))?;
        let area_km2 = mesh::area_km2(&mesh_code)?;

        let population = record.get(population_at).and_then(number);
        rows.push(Row {
            mesh_code,
            population,
            households: record.get(households_at).and_then(number),
            density: population.map(|p| p as f64 / area_km2),
            geometry,
        });
    }

    if rows.is_empty() {
        bail!("データ行がありません");
    }
    Ok(rows)
}

/// 束ねている途中の1セル。
#[derive(Debug, Default)]
pub struct Cell {
    population: Option<i64>,
    households: Option<i64>,
    density: Option<f64>,
}

/// メッシュを粗くして束ねる。**メッシュコードを前から `digits` 桁で切るだけ。**
///
/// 地域メッシュは入れ子になっているので、8桁に切れば1km、6桁なら10kmになる。
/// 集約のために別のデータを落とす必要はない。
///
/// **人口と世帯数は合計、密度は最大。** 人口・世帯数は125mの時点で秘匿されていない
/// (実測: 東京都65,138メッシュのうち秘匿0件) ので、合計は正確に出る。
///
/// 都道府県をまたいで呼ぶことを想定して、`into` に積み上げる形にしてある。
/// **1つの1kmメッシュが県境をまたぐことがある**ので、全県を積んでから確定する。
pub fn accumulate(into: &mut BTreeMap<String, Cell>, rows: &[Row], digits: usize) {
    for row in rows {
        if row.mesh_code.len() < digits {
            continue;
        }
        let cell = into.entry(row.mesh_code[..digits].to_string()).or_default();
        if let Some(population) = row.population {
            *cell.population.get_or_insert(0) += i64::from(population);
        }
        if let Some(households) = row.households {
            *cell.households.get_or_insert(0) += i64::from(households);
        }
        if let Some(density) = row.density {
            cell.density = Some(cell.density.map_or(density, |current| current.max(density)));
        }
    }
}

/// 束ねた結果を書き出せる形にする。
pub fn aggregate(cells: BTreeMap<String, Cell>) -> Result<Vec<Row>> {
    cells
        .into_iter()
        .map(|(mesh_code, cell)| {
            let geometry = mesh::polygon(&mesh_code)
                .with_context(|| format!("メッシュコードを解釈できません: {mesh_code}"))?;
            Ok(Row {
                mesh_code,
                // 束ねた人口は i32 に収まる (全国で1.26億)。収まらなければ
                // 束ね方を間違えているので、黙って丸めずに落とす。
                population: cell.population.map(i32::try_from).transpose()?,
                households: cell.households.map(i32::try_from).transpose()?,
                density: cell.density,
                geometry,
            })
        })
        .collect()
}

fn polygon_bbox(polygon: &Polygon<f64>) -> [f64; 4] {
    let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for coord in polygon.exterior().coords() {
        let (x, y) = (coord.x(), coord.y());
        bbox[0] = bbox[0].min(x);
        bbox[1] = bbox[1].min(y);
        bbox[2] = bbox[2].max(x);
        bbox[3] = bbox[3].max(y);
    }
    bbox
}

pub fn write_geoparquet(rows: Vec<Row>, output: &Path) -> Result<()> {
    let mut mesh_code = Vec::with_capacity(rows.len());
    let mut population = Vec::with_capacity(rows.len());
    let mut households = Vec::with_capacity(rows.len());
    let mut density = Vec::with_capacity(rows.len());
    let mut geometries = Vec::with_capacity(rows.len());
    for row in rows {
        mesh_code.push(row.mesh_code);
        population.push(row.population);
        households.push(row.households);
        density.push(row.density);
        geometries.push(row.geometry);
    }

    let (geometry, bbox, file_bbox) = geoparquet::geometry_columns(&geometries, polygon_bbox)?;

    let columns = vec![
        geoparquet::utf8_column("mesh_code", mesh_code.into_iter()),
        geoparquet::i32_nullable_column("population", population.into_iter()),
        geoparquet::i32_nullable_column("households", households.into_iter()),
        geoparquet::f64_nullable_column("density", density.into_iter()),
    ];

    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["Polygon".to_string()],
        file_bbox,
        // 配布元は出所全体で1つ (e-Statの統計GIS)。カタログ側が持つ。
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 配布物と同じ形の、2行ヘッダのCSV。
    const SAMPLE: &str = "\
KEY_CODE,HTKSYORI,HTKSAKI,GASSAN,T001231001,T001231034
,,,,　人口（総数）,　世帯総数
53394611311,0,,,320,150
53394611312,2,53394611311,,1,*
";

    #[test]
    fn reads_population_and_households() {
        let rows = parse_csv(SAMPLE).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].mesh_code, "53394611311");
        assert_eq!(rows[0].population, Some(320));
        assert_eq!(rows[0].households, Some(150));
    }

    // 秘匿された欄は `*` で来る。0として読むと人口密度が過小に出る。
    #[test]
    fn treats_suppressed_values_as_missing() {
        let rows = parse_csv(SAMPLE).unwrap();
        assert_eq!(rows[1].population, Some(1));
        assert_eq!(rows[1].households, None);
    }

    // 面積は緯度で変わるので、定数ではなくコードから計算した面積で割る。
    #[test]
    fn density_uses_the_area_of_that_mesh() {
        let rows = parse_csv(SAMPLE).unwrap();
        let area = mesh::area_km2("53394611311").unwrap();
        let expected = 320.0 / area;
        let density = rows[0].density.unwrap();
        assert!((density - expected).abs() < 1e-9, "{density} vs {expected}");
        // 125mメッシュは約0.0156km²なので、320人なら2万人/km²の桁になる。
        assert!((15_000.0..30_000.0).contains(&density), "{density}");
    }

    // 項目コード (T001231001) は調査年や統計表で変わるので、項目名で引いている。
    // 名前が見つからないときは、何があるかを見せて落とす。
    #[test]
    fn reports_available_columns_when_the_name_is_missing() {
        let csv = "KEY_CODE,T001231001\n,　男女別人口\n53394611311,320\n";
        let err = parse_csv(csv).unwrap_err();
        let message = format!("{err:#}");
        assert!(message.contains("人口（総数）"), "{message}");
        assert!(message.contains("男女別人口"), "{message}");
    }

    // 境界データの方を落としてくると1列目が違う。読み進める前に止める。
    #[test]
    fn rejects_a_file_that_is_not_mesh_statistics() {
        let err = parse_csv("KEY,VALUE\n,\n1,2\n").unwrap_err();
        assert!(format!("{err:#}").contains("KEY_CODE"), "{err:#}");
    }

    /// 同じ1kmメッシュ (53394611) に入る125mメッシュを並べたCSV。
    const SIBLINGS: &str = "\
KEY_CODE,HTKSYORI,HTKSAKI,GASSAN,T001231001,T001231034
,,,,　人口（総数）,　世帯総数
53394611111,0,,,100,40
53394611444,0,,,300,120
";

    // 人口と世帯数は合計。125mの時点で秘匿されていないので、合計は正確に出る。
    #[test]
    fn sums_population_and_households() {
        let rows = parse_csv(SIBLINGS).unwrap();
        let mut cells = BTreeMap::new();
        accumulate(&mut cells, &rows, 8);
        let aggregated = aggregate(cells).unwrap();

        assert_eq!(aggregated.len(), 1);
        assert_eq!(aggregated[0].mesh_code, "53394611");
        assert_eq!(aggregated[0].population, Some(400));
        assert_eq!(aggregated[0].households, Some(160));
    }

    // **密度は平均ではなく最大。** 平均にすると危ないセルが薄まって消える。
    // SORAは運航範囲の中で最も密度の高いところを採るため。
    #[test]
    fn keeps_the_highest_density_when_aggregating() {
        let rows = parse_csv(SIBLINGS).unwrap();
        let highest = rows
            .iter()
            .filter_map(|row| row.density)
            .fold(f64::MIN, f64::max);

        let mut cells = BTreeMap::new();
        accumulate(&mut cells, &rows, 8);
        let aggregated = aggregate(cells).unwrap();

        let density = aggregated[0].density.unwrap();
        assert!((density - highest).abs() < 1e-9, "{density} vs {highest}");
        // 1kmの面積で割った値 (400人 / 約0.9km²) より、ずっと大きいはず。
        assert!(density > 10_000.0, "{density}");
    }

    // 1つのメッシュが県境をまたぐことがあるので、複数のファイルから積み上げられること。
    #[test]
    fn accumulates_across_files() {
        let mut cells = BTreeMap::new();
        for csv in [SIBLINGS, SIBLINGS] {
            accumulate(&mut cells, &parse_csv(csv).unwrap(), 8);
        }
        let aggregated = aggregate(cells).unwrap();
        assert_eq!(aggregated.len(), 1);
        assert_eq!(aggregated[0].population, Some(800));
    }

    // 束ねた先の矩形もメッシュコードから計算する。1kmは125mの64倍の面積。
    #[test]
    fn aggregated_geometry_is_the_parent_mesh() {
        let rows = parse_csv(SIBLINGS).unwrap();
        let mut cells = BTreeMap::new();
        accumulate(&mut cells, &rows, 8);
        let aggregated = aggregate(cells).unwrap();

        let parent = mesh::area_km2("53394611").unwrap();
        let child = mesh::area_km2("53394611111").unwrap();
        assert!((parent / child - 64.0).abs() < 0.1, "{parent} / {child}");
        assert_eq!(
            aggregated[0].geometry.exterior().0.len(),
            5,
            "閉じた矩形は5点"
        );
    }
}
