/**
 * SIC Code → 板块大类映射
 *
 * SIC (Standard Industrial Classification) 前 2 位映射到 11 个板块大类
 * 参考: https://www.osha.gov/data/sic-manual
 */

// SIC 前两位 → 板块
const SIC_SECTOR_MAP: Record<string, string> = {
  // Agriculture, Forestry, Fishing
  "01": "Agriculture",
  "02": "Agriculture",
  "07": "Agriculture",
  "08": "Agriculture",
  "09": "Agriculture",

  // Mining
  "10": "Mining & Energy",
  "12": "Mining & Energy",
  "13": "Mining & Energy", // Oil & Gas Extraction
  "14": "Mining & Energy",

  // Construction
  "15": "Construction",
  "16": "Construction",
  "17": "Construction",

  // Manufacturing — split into subcategories
  "20": "Consumer Staples",  // Food
  "21": "Consumer Staples",  // Tobacco
  "22": "Consumer Discretionary", // Textiles
  "23": "Consumer Discretionary", // Apparel
  "24": "Materials",         // Lumber & Wood
  "25": "Consumer Discretionary", // Furniture
  "26": "Materials",         // Paper
  "27": "Communication",     // Printing & Publishing
  "28": "Healthcare",        // Chemicals / Pharma
  "29": "Mining & Energy",   // Petroleum Refining
  "30": "Materials",         // Rubber & Plastics
  "31": "Consumer Discretionary", // Leather
  "32": "Materials",         // Stone, Clay, Glass
  "33": "Materials",         // Primary Metals
  "34": "Industrials",       // Fabricated Metals
  "35": "Technology",        // Industrial Machinery & Computers
  "36": "Technology",        // Electronic Equipment
  "37": "Industrials",       // Transportation Equipment
  "38": "Technology",        // Instruments
  "39": "Consumer Discretionary", // Misc Manufacturing

  // Transportation & Utilities
  "40": "Industrials",       // Railroad
  "41": "Industrials",       // Local Transit
  "42": "Industrials",       // Trucking & Warehousing
  "43": "Communication",     // USPS (rare)
  "44": "Industrials",       // Water Transportation
  "45": "Industrials",       // Air Transportation
  "46": "Industrials",       // Pipelines
  "47": "Industrials",       // Transportation Services
  "48": "Communication",     // Communications
  "49": "Utilities",         // Electric, Gas, Sanitary

  // Wholesale Trade
  "50": "Consumer Discretionary",
  "51": "Consumer Staples",

  // Retail Trade
  "52": "Consumer Discretionary", // Building Materials
  "53": "Consumer Discretionary", // General Merchandise
  "54": "Consumer Staples",       // Food Stores
  "55": "Consumer Discretionary", // Auto Dealers
  "56": "Consumer Discretionary", // Apparel Stores
  "57": "Consumer Discretionary", // Furniture Stores
  "58": "Consumer Discretionary", // Eating & Drinking
  "59": "Consumer Discretionary", // Retail Misc

  // Finance, Insurance, Real Estate
  "60": "Financial",         // Depository Institutions
  "61": "Financial",         // Non-depository Credit
  "62": "Financial",         // Security Brokers
  "63": "Financial",         // Insurance Carriers
  "64": "Financial",         // Insurance Agents
  "65": "Real Estate",       // Real Estate
  "67": "Financial",         // Holding & Investment

  // Services
  "70": "Consumer Discretionary", // Hotels & Lodging
  "72": "Consumer Discretionary", // Personal Services
  "73": "Technology",             // Business Services (incl Software)
  "75": "Consumer Discretionary", // Auto Repair
  "76": "Consumer Discretionary", // Misc Repair
  "78": "Communication",          // Motion Pictures
  "79": "Consumer Discretionary",  // Amusement & Recreation
  "80": "Healthcare",              // Health Services
  "81": "Professional Services",   // Legal Services
  "82": "Professional Services",   // Educational Services
  "83": "Professional Services",   // Social Services
  "84": "Professional Services",   // Museums
  "86": "Professional Services",   // Membership Organizations
  "87": "Professional Services",   // Engineering & Management
  "89": "Professional Services",   // Services NEC

  // Public Administration
  "91": "Government",
  "92": "Government",
  "93": "Government",
  "94": "Government",
  "95": "Government",
  "96": "Government",
  "97": "Government",
  "99": "Other",
};

/**
 * 根据 SIC code 返回板块大类
 */
export function sicToSector(sicCode: string | null | undefined): string {
  if (!sicCode) return "Unknown";
  const prefix = sicCode.slice(0, 2);
  return SIC_SECTOR_MAP[prefix] || "Other";
}

/**
 * 获取所有板块名称列表（用于前端下拉）
 */
export function getAllSectors(): string[] {
  const unique = new Set(Object.values(SIC_SECTOR_MAP));
  unique.add("Unknown");
  return Array.from(unique).sort();
}
