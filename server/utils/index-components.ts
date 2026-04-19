/**
 * 指数成分股管理（硬编码版本）
 *
 * SP500 和 NASDAQ-100 成分股列表直接内置
 * 避免国内服务器无法访问 Wikipedia 的问题
 *
 * 数据来源: Wikipedia (2026-04-19)
 * SP500: https://en.wikipedia.org/wiki/List_of_S%26P_500_companies
 * NDX100: https://en.wikipedia.org/wiki/Nasdaq-100
 */
import type Database from "better-sqlite3";

interface ComponentStock {
  ticker: string;
  companyName: string;
}

// ─── S&P 500 成分股 (503 只, 2026-04-19 更新) ───
const SP500_TICKERS = [
  "MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A",
  "APD","ABNB","AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL",
  "GOOG","MO","AMZN","AMCR","AEE","AEP","AXP","AIG","AMT","AWK",
  "AMP","AME","AMGN","APH","ADI","AON","APA","APO","AAPL","AMAT",
  "APP","APTV","ACGL","ADM","ARES","ANET","AJG","AIZ","T","ATO",
  "ADSK","ADP","AZO","AVB","AVY","AXON","BKR","BALL","BAC","BAX",
  "BDX","BRK-B","BBY","TECH","BIIB","BLK","BX","XYZ","BK","BA",
  "BKNG","BSX","BMY","AVGO","BR","BRO","BF-B","BLDR","BG","BXP",
  "CHRW","CDNS","CPT","CPB","COF","CAH","CCL","CARR","CVNA","CASY",
  "CAT","CBOE","CBRE","CDW","COR","CNC","CNP","CF","CRL","SCHW",
  "CHTR","CVX","CMG","CB","CHD","CIEN","CI","CINF","CTAS","CSCO",
  "C","CFG","CLX","CME","CMS","KO","CTSH","COHR","COIN","CL",
  "CMCSA","FIX","CAG","COP","ED","STZ","CEG","COO","CPRT","GLW",
  "CPAY","CTVA","CSGP","COST","CTRA","CRH","CRWD","CCI","CSX","CMI",
  "CVS","DHR","DRI","DDOG","DVA","DECK","DE","DELL","DAL","DVN",
  "DXCM","FANG","DLR","DG","DLTR","D","DPZ","DASH","DOV","DOW",
  "DHI","DTE","DUK","DD","ETN","EBAY","SATS","ECL","EIX","EW",
  "EA","ELV","EME","EMR","ETR","EOG","EPAM","EQT","EFX","EQIX",
  "EQR","ERIE","ESS","EL","EG","EVRG","ES","EXC","EXE","EXPE",
  "EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FIS",
  "FITB","FSLR","FE","FISV","F","FTNT","FTV","FOXA","FOX","BEN",
  "FCX","GRMN","IT","GE","GEHC","GEV","GEN","GNRC","GD","GIS",
  "GM","GPC","GILD","GPN","GL","GDDY","GS","HAL","HIG","HAS",
  "HCA","DOC","HSIC","HSY","HPE","HLT","HD","HON","HRL","HST",
  "HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW",
  "INCY","IR","PODD","INTC","IBKR","ICE","IFF","IP","INTU","ISRG",
  "IVZ","INVH","IQV","IRM","JBHT","JBL","JKHY","J","JNJ","JCI",
  "JPM","KVUE","KDP","KEY","KEYS","KMB","KIM","KMI","KKR","KLAC",
  "KHC","KR","LHX","LH","LRCX","LVS","LDOS","LEN","LII","LLY",
  "LIN","LYV","LMT","L","LOW","LULU","LITE","LYB","MTB","MPC",
  "MAR","MRSH","MLM","MAS","MA","MKC","MCD","MCK","MDT","MRK",
  "META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","TAP",
  "MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI","NDAQ","NTAP",
  "NFLX","NEM","NWSA","NWS","NEE","NKE","NI","NDSN","NSC","NTRS",
  "NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY","ODFL",
  "OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PSKY",
  "PH","PAYX","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW",
  "PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG",
  "PTC","PSA","PHM","PWR","QCOM","DGX","Q","RL","RJF","RTX",
  "O","REG","REGN","RF","RSG","RMD","RVTY","HOOD","ROK","ROL",
  "ROP","ROST","RCL","SPGI","CRM","SNDK","SBAC","SLB","STX","SRE",
  "NOW","SHW","SPG","SWKS","SJM","SW","SNA","SOLV","SO","LUV",
  "SWK","SBUX","STT","STLD","STE","SYK","SMCI","SYF","SNPS","SYY",
  "TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TER","TSLA",
  "TXN","TPL","TXT","TMO","TJX","TKO","TTD","TSCO","TT","TDG",
  "TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","ULTA","UNP",
  "UAL","UPS","URI","UNH","UHS","VLO","VTR","VLTO","VRSN","VRSK",
  "VZ","VRTX","VRT","VTRS","VICI","V","VST","VMC","WRB","GWW",
  "WAB","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST",
  "WDC","WY","WSM","WMB","WTW","WDAY","WYNN","XEL","XYL","YUM",
  "ZBRA","ZBH","ZTS",
] as const;

// ─── NASDAQ-100 成分股 (101 只, 2026-01-20 更新) ───
const NASDAQ100_TICKERS = [
  "ADBE","AMD","ABNB","ALNY","GOOGL","GOOG","AMZN","AEP","AMGN","ADI",
  "AAPL","AMAT","APP","ARM","ASML","TEAM","ADSK","ADP","AXON","BKR",
  "BKNG","AVGO","CDNS","CHTR","CTAS","CSCO","CCEP","CTSH","CMCSA","CEG",
  "CPRT","CSGP","COST","CRWD","CSX","DDOG","DXCM","FANG","DASH","EA",
  "EXC","FAST","FER","FTNT","GEHC","GILD","HON","IDXX","INSM","INTC",
  "INTU","ISRG","KDP","KLAC","KHC","LRCX","LIN","MAR","MRVL","MELI",
  "META","MCHP","MU","MSFT","MSTR","MDLZ","MPWR","MNST","NFLX","NVDA",
  "NXPI","ORLY","ODFL","PCAR","PLTR","PANW","PAYX","PYPL","PDD","PEP",
  "QCOM","REGN","ROP","ROST","STX","SHOP","SBUX","SNPS","TMUS","TTWO",
  "TSLA","TXN","TRI","VRSK","VRTX","WMT","WBD","WDC","WDAY","XEL",
  "ZS",
] as const;

const BUILTIN_DATA: Record<string, readonly string[]> = {
  sp500: SP500_TICKERS,
  nasdaq100: NASDAQ100_TICKERS,
};

/**
 * 刷新指定指数的成分股到数据库（从内置数据）
 */
export async function refreshIndexComponents(
  db: Database.Database,
  indexName: string
): Promise<{ count: number; indexName: string }> {
  const tickers = BUILTIN_DATA[indexName];
  if (!tickers) {
    throw new Error(`Unknown index: ${indexName}. Available: ${Object.keys(BUILTIN_DATA).join(", ")}`);
  }

  console.log(`[Index] 写入 ${indexName} 成分股: ${tickers.length} 只`);

  const deleteStmt = db.prepare("DELETE FROM index_components WHERE index_name = ?");
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO index_components (index_name, ticker, company_name, updated_at) VALUES (?, ?, ?, ?)"
  );

  const now = new Date().toISOString();

  db.transaction(() => {
    deleteStmt.run(indexName);
    for (const ticker of tickers) {
      insertStmt.run(indexName, ticker, "", now);
    }
  })();

  console.log(`[Index] ${indexName}: 已写入 ${tickers.length} 只股票`);
  return { count: tickers.length, indexName };
}

/**
 * 刷新所有指数
 */
export async function refreshAllIndexComponents(
  db: Database.Database
): Promise<Array<{ count: number; indexName: string }>> {
  const results = [];
  for (const indexName of Object.keys(BUILTIN_DATA)) {
    try {
      const r = await refreshIndexComponents(db, indexName);
      results.push(r);
    } catch (err: any) {
      console.error(`[Index] ${indexName} 刷新失败: ${err?.message}`);
      results.push({ count: 0, indexName });
    }
  }
  return results;
}

/**
 * 获取指定指数的 ticker 集合（用于 screener 过滤）
 */
export function getIndexTickers(
  db: Database.Database,
  indexNames: string[]
): Set<string> {
  if (indexNames.length === 0) return new Set();

  const placeholders = indexNames.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT DISTINCT ticker FROM index_components WHERE index_name IN (${placeholders})`)
    .all(...indexNames) as Array<{ ticker: string }>;

  return new Set(rows.map((r) => r.ticker));
}

/**
 * 获取所有指数的统计信息
 */
export function getIndexStats(
  db: Database.Database
): Array<{ index_name: string; count: number; updated_at: string | null }> {
  return db
    .prepare(
      `SELECT index_name, COUNT(*) as count, MAX(updated_at) as updated_at
       FROM index_components GROUP BY index_name ORDER BY index_name`
    )
    .all() as Array<{ index_name: string; count: number; updated_at: string | null }>;
}
