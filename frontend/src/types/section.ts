/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 岸边流速系数默认值（按测法）：流速仪 0.70、浮标 0.75、ADCP 0.60 */
export const BANK_COEF_DEFAULTS: Record<MeasureMethod, number> = {
  流速仪: 0.7,
  浮标: 0.75,
  ADCP: 0.6
}

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 左岸岸边流速系数（手填值）；null 表示未填，按测法取默认 */
  bankLeftCoef: number | null
  /** 右岸岸边流速系数（手填值）；null 表示未填，按测法取默认 */
  bankRightCoef: number | null
  /** 测流时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 岸边流速系数来源：手填优先，其次按测法取默认，测法无法识别则不折算 */
export type BankCoefSource = '手填' | '默认' | '未折算'

/** 单侧岸边系数的取值结论 */
export interface BankSideResolution {
  /** 实际参与计算的系数（未折算时为 1） */
  coef: number
  source: BankCoefSource
}

/** 左右岸系数的取值结论 */
export interface BankCoefResolution {
  left: BankSideResolution
  right: BankSideResolution
  /** 至少一侧真正参与了折算 */
  applied: boolean
  /** 测法无法识别、没有默认值可取 */
  methodUnknown: boolean
}

/** 按测法取岸边系数默认值；测法无法识别时返回 null */
export function defaultBankCoef(method: string): number | null {
  return (BANK_COEF_DEFAULTS as Record<string, number>)[method] ?? null
}

/**
 * 解析某测次实际使用的岸边流速系数：
 * 手填值优先；未填按测法取默认；测法也无法识别时不折算（系数取 1 并标记出来）。
 */
export function resolveBankCoefficients(
  section: Pick<Section, 'method'> & Partial<Pick<Section, 'bankLeftCoef' | 'bankRightCoef'>>
): BankCoefResolution {
  const fallback = defaultBankCoef(section.method)
  const resolveSide = (manual: number | null | undefined): BankSideResolution => {
    if (typeof manual === 'number' && Number.isFinite(manual)) {
      return { coef: manual, source: '手填' }
    }
    if (fallback !== null) return { coef: fallback, source: '默认' }
    return { coef: 1, source: '未折算' }
  }
  const left = resolveSide(section.bankLeftCoef)
  const right = resolveSide(section.bankRightCoef)
  return {
    left,
    right,
    applied: left.source !== '未折算' || right.source !== '未折算',
    methodUnknown: fallback === null
  }
}

/** 单侧系数文案：0.70（默认）/ 0.68（手填）/ 未折算 */
export function formatBankSideText(side: BankSideResolution): string {
  if (side.source === '未折算') return '未折算'
  return `${side.coef.toFixed(2)}（${side.source}）`
}

/** 左右岸系数结论文案，供测次列表、垂线页与检测结论共用 */
export function formatBankCoefText(resolution: BankCoefResolution): string {
  if (!resolution.applied) return '未折算（测法未识别）'
  return `左 ${formatBankSideText(resolution.left)} · 右 ${formatBankSideText(resolution.right)}`
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
