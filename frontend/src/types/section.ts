/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 岸边流速系数来源：手填 / 按测法默认 / 不折算（认不出测法或未配默认） */
export type BankCoefSource = 'manual' | 'default' | 'none'

/** 各测法的岸边流速系数默认值：流速仪 0.7、浮标 0.75、ADCP 0.6 */
export const BANK_COEF_DEFAULTS: Readonly<Partial<Record<MeasureMethod, number>>> = {
  流速仪: 0.7,
  浮标: 0.75,
  ADCP: 0.6
}

/** 认不出的测法一律不折算，系数按 1 处理 */
export const BANK_COEF_UNRESOLVED = 1

/** 判断测法是否能取到岸边系数默认值 */
export function isKnownMeasureMethod(method: string | null | undefined): method is MeasureMethod {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(BANK_COEF_DEFAULTS, method)
}

/** 取某测法的岸边系数默认值；认不出时返回 null（调用方按不折算处理） */
export function defaultBankCoef(method: string | null | undefined): number | null {
  return isKnownMeasureMethod(method) ? BANK_COEF_DEFAULTS[method] ?? null : null
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
  /**
   * 左岸岸边流速系数（手填值）。未填（undefined / null）时按测法取默认。
   * 折算只压在最左垂线分担的面积上。
   */
  leftBankCoef: number | null
  /** 右岸岸边流速系数（手填值），规则同左岸 */
  rightBankCoef: number | null
  /** 左岸系数来源：手填以手填为准，未填按测法取默认，认不出测法为 none（不折算） */
  leftBankCoefSource: BankCoefSource
  /** 右岸系数来源 */
  rightBankCoefSource: BankCoefSource
  /** 测流时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 单岸系数解析结果 */
export interface ResolvedBankCoef {
  /** 参与折算的系数；不折算时为 1 */
  value: number
  /** 来源：手填 / 默认 / 不折算 */
  source: BankCoefSource
  /** 采用默认值时回显对应测法的默认值，便于界面说明 */
  defaultValue: number | null
}

/** 一个测次左右岸的系数解析结果 */
export interface ResolvedSectionBankCoefs {
  left: ResolvedBankCoef
  right: ResolvedBankCoef
  /** 测法是否能识别（false 时本测次不做岸边折算） */
  methodKnown: boolean
}

/**
 * 解析某一岸的岸边流速系数：
 * 1. 手填了有效系数（0<系数≤1）以手填为准（manual）；
 * 2. 没手填按测法取默认（流速仪 0.7、浮标 0.75、ADCP 0.6，default）；
 * 3. 测法认不出来先不折算（系数 1，none）。
 * 手填值是否存在是唯一判定依据，持久化的来源标记仅用于升级留痕。
 */
export function resolveBankCoef(
  manual: number | null | undefined,
  method: string | null | undefined
): ResolvedBankCoef {
  const fallback = defaultBankCoef(method)
  if (typeof manual === 'number' && Number.isFinite(manual) && manual > 0 && manual <= 1) {
    return { value: manual, source: 'manual', defaultValue: fallback }
  }
  if (fallback !== null) {
    return { value: fallback, source: 'default', defaultValue: fallback }
  }
  return { value: BANK_COEF_UNRESOLVED, source: 'none', defaultValue: null }
}

/** 解析一个测次左右岸的岸边流速系数 */
export function resolveSectionBankCoefs(
  section: Pick<Section, 'method' | 'leftBankCoef' | 'rightBankCoef'>
): ResolvedSectionBankCoefs {
  return {
    left: resolveBankCoef(section.leftBankCoef, section.method),
    right: resolveBankCoef(section.rightBankCoef, section.method),
    methodKnown: isKnownMeasureMethod(section.method)
  }
}

/** 由表单手填值（空串表示未填）落库：同时确定来源标记 */
export function bankCoefInputToStore(
  input: number | null,
  method: string | null | undefined
): { value: number | null; source: BankCoefSource } {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0 && input <= 1) {
    return { value: Number(input.toFixed(3)), source: 'manual' }
  }
  return { value: null, source: defaultBankCoef(method) !== null ? 'default' : 'none' }
}

/** 来源中文文案（结论、提示共用） */
export const BANK_COEF_SOURCE_TEXT: Record<BankCoefSource, string> = {
  manual: '手填',
  default: '默认',
  none: '不折算'
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
