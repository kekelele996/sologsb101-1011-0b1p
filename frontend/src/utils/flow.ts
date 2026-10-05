/**
 * 流量计算工具：垂线加权平均流速、部分面积法与断面流量计算。
 * 页面、store 与数据库播种共用同一套算法，保证展示值与存储值一致。
 */
import type { BankCoefSource, ResolvedSectionBankCoefs } from '@/types/section'

/** 默认计算权重：一点法 1.0、两点法 0.5/0.5、三点法 1/3、五点法 0.2 */
export const DEFAULT_WEIGHTS: number[] = [1, 0.5, 1 / 3, 0.25, 0.2]

/** 保留小数位（避免浮点误差累积） */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 加权平均流速：权重缺失时按算术平均 */
export function calcMeanVelocity(rows: Array<{ velocityMs: number; weight?: number }>): number {
  const valid = rows.filter((row) => Number.isFinite(row.velocityMs) && row.velocityMs >= 0)
  if (valid.length === 0) return 0
  const totalWeight = valid.reduce((sum, row) => sum + (row.weight && row.weight > 0 ? row.weight : 0), 0)
  if (totalWeight <= 0) {
    const sum = valid.reduce((acc, row) => acc + row.velocityMs, 0)
    return round(sum / valid.length, 3)
  }
  const weighted = valid.reduce(
    (sum, row) => sum + row.velocityMs * (row.weight && row.weight > 0 ? row.weight : 0),
    0
  )
  return round(weighted / totalWeight, 3)
}

/** 按相对水深自动分配权重：水面/河底 0.1、0.2/0.8 各 0.3、0.6 计 0.3，归一化后返回 */
export function autoWeights(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [1]
  return Array.from({ length: count }, () => round(1 / count, 4))
}

/** 断面垂线输入（按起点距升序） */
export interface VerticalSlice {
  id: string
  no: number
  startDistanceM: number
  depthM: number
  meanVelocityMs: number
}

/** 岸边不折算时的系数（垂线平均流速原样计入） */
export const BANK_COEF_PLAIN = 1

/** 部分面积法计算成果 */
export interface DischargeResult {
  /** 断面流量（m³/s，岸边垂线已乘系数） */
  flowM3s: number
  /** 岸边折算前的断面流量（m³/s，所有垂线均按垂线平均流速原样计入） */
  rawFlowM3s: number
  /** 岸边流速系数折算掉的流量（m³/s，rawFlowM3s - flowM3s） */
  bankReducedFlowM3s: number
  /** 断面面积（m²，岸边系数只压流速、不压面积） */
  areaM2: number
  /** 断面平均流速（m/s，按折减后流量计） */
  meanVelocityMs: number
  /** 最大水深（m） */
  maxDepthM: number
  /** 水面宽（m） */
  widthM: number
  /** 本断面实际采用的左岸系数（不折算为 1） */
  leftBankCoef: number
  /** 本断面实际采用的右岸系数（不折算为 1） */
  rightBankCoef: number
  /** 左岸系数来源 */
  leftBankCoefSource: BankCoefSource
  /** 右岸系数来源 */
  rightBankCoefSource: BankCoefSource
  /** 是否做了岸边折算（任一岸系数 < 1） */
  bankAdjusted: boolean
  /** 测法认不出、未折算时为 true，界面需标出 */
  bankSkipped: boolean
  /** 逐垂线的部分面积与部分流量 */
  slices: Array<{
    id: string
    no: number
    partialAreaM2: number
    /** 折减前部分流量（m³/s）：部分面积 × 垂线平均流速 */
    rawPartialFlow: number
    /** 折减后部分流量（m³/s）：岸边垂线再乘岸边系数，中间垂线与折减前相同 */
    partialFlow: number
    /** 本垂线采用的岸边流速系数（最左取左岸、最右取右岸，其余为 1） */
    bankCoef: number
    /** 是否岸边垂线（最左 / 最右） */
    bankSide: 'left' | 'right' | null
    /** 本垂线系数来源（中间垂线为 null） */
    bankCoefSource: BankCoefSource | null
  }>
}

/** 岸边折算输入：左右岸解析后的系数；不传则全断面不折算 */
export interface BankCoefOption {
  bankCoefs?: ResolvedSectionBankCoefs | null
}

/**
 * 部分面积法（mid-section）计算断面流量：
 * 以每条垂线为中心，左右各取半间距合成部分宽度，部分流量 = 部分宽度 × 水深 × 垂线平均流速。
 * 岸边流速系数只压在最左、最右两条垂线各自分担的面积上：
 * 最左垂线再乘左岸系数、最右垂线再乘右岸系数，中间垂线照原样；面积本身不折减。
 */
export function calcSectionDischarge(input: VerticalSlice[], option: BankCoefOption = {}): DischargeResult {
  const resolved = option.bankCoefs ?? null
  const leftCoef = resolved?.left.value ?? BANK_COEF_PLAIN
  const rightCoef = resolved?.right.value ?? BANK_COEF_PLAIN
  const leftSource: BankCoefSource = resolved?.left.source ?? 'none'
  const rightSource: BankCoefSource = resolved?.right.source ?? 'none'
  const bankSkipped = resolved !== null && !resolved.methodKnown

  const verticals = [...input]
    .filter((vertical) => Number.isFinite(vertical.startDistanceM) && Number.isFinite(vertical.depthM))
    .sort((a, b) => a.startDistanceM - b.startDistanceM)

  const buildEmpty = (): DischargeResult => ({
    flowM3s: 0,
    rawFlowM3s: 0,
    bankReducedFlowM3s: 0,
    areaM2: 0,
    meanVelocityMs: 0,
    maxDepthM: 0,
    widthM: 0,
    leftBankCoef: leftCoef,
    rightBankCoef: rightCoef,
    leftBankCoefSource: leftSource,
    rightBankCoefSource: rightSource,
    bankAdjusted: false,
    bankSkipped,
    slices: []
  })
  if (verticals.length === 0) return buildEmpty()

  // 单垂线不区分两岸，也没有相邻垂线分担部分宽度，按不折算处理（部分宽度按 1 m 示意）
  if (verticals.length === 1) {
    const only = verticals[0]
    const partialAreaM2 = round(only.depthM * 1, 3)
    const rawPartialFlow = round(partialAreaM2 * only.meanVelocityMs, 3)
    return {
      ...buildEmpty(),
      flowM3s: rawPartialFlow,
      rawFlowM3s: rawPartialFlow,
      areaM2: partialAreaM2,
      meanVelocityMs: round(only.meanVelocityMs, 3),
      maxDepthM: round(only.depthM, 2),
      slices: [
        {
          id: only.id,
          no: only.no,
          partialAreaM2,
          rawPartialFlow,
          partialFlow: rawPartialFlow,
          bankCoef: BANK_COEF_PLAIN,
          bankSide: null,
          bankCoefSource: null
        }
      ]
    }
  }

  const slices = verticals.map((vertical, index) => {
    const previous = verticals[index - 1]
    const next = verticals[index + 1]
    const leftSpan = previous ? (vertical.startDistanceM - previous.startDistanceM) / 2 : 0
    const rightSpan = next ? (next.startDistanceM - vertical.startDistanceM) / 2 : 0
    const span = leftSpan + rightSpan
    const partialAreaM2 = round(vertical.depthM * span, 3)
    const rawPartialFlow = round(partialAreaM2 * vertical.meanVelocityMs, 3)
    // 仅两条垂线时首条为最左、末条为最右，各按本岸系数折算，互不重复
    const isLeftBank = index === 0
    const isRightBank = index === verticals.length - 1
    const bankCoef = isLeftBank ? leftCoef : isRightBank ? rightCoef : BANK_COEF_PLAIN
    const bankSide: 'left' | 'right' | null = isLeftBank ? 'left' : isRightBank ? 'right' : null
    const bankCoefSource: BankCoefSource | null = isLeftBank ? leftSource : isRightBank ? rightSource : null
    const partialFlow = round(rawPartialFlow * bankCoef, 3)
    return { id: vertical.id, no: vertical.no, partialAreaM2, rawPartialFlow, partialFlow, bankCoef, bankSide, bankCoefSource }
  })

  const areaM2 = round(
    slices.reduce((sum, slice) => sum + slice.partialAreaM2, 0),
    2
  )
  const flowM3s = round(
    slices.reduce((sum, slice) => sum + slice.partialFlow, 0),
    3
  )
  const rawFlowM3s = round(
    slices.reduce((sum, slice) => sum + slice.rawPartialFlow, 0),
    3
  )
  const widthM = round(
    verticals[verticals.length - 1].startDistanceM - verticals[0].startDistanceM,
    2
  )
  const maxDepthM = round(
    Math.max(...verticals.map((vertical) => vertical.depthM)),
    2
  )
  return {
    flowM3s,
    rawFlowM3s,
    bankReducedFlowM3s: round(rawFlowM3s - flowM3s, 3),
    areaM2,
    meanVelocityMs: areaM2 > 0 ? round(flowM3s / areaM2, 3) : 0,
    maxDepthM,
    widthM,
    leftBankCoef: leftCoef,
    rightBankCoef: rightCoef,
    leftBankCoefSource: leftSource,
    rightBankCoefSource: rightSource,
    bankAdjusted: leftCoef < 1 || rightCoef < 1,
    bankSkipped,
    slices
  }
}

/** 由垂线水深与平均流速估算单宽流量（m²/s），用于断面流速分布展示 */
export function unitDischarge(depthM: number, meanVelocityMs: number): number {
  return round(depthM * meanVelocityMs, 3)
}

/** 流速仪测点历时换算：转数 / 历时 → 流速（简化直线公式，供测点录入校验提示） */
export function velocityFromRevolutions(revolutions: number, durationS: number, k = 0.25, c = 0.01): number {
  if (!Number.isFinite(revolutions) || !Number.isFinite(durationS) || durationS <= 0) return 0
  return round(k * (revolutions / durationS) + c, 3)
}

/** 水位流量关系幂函数值：Q = a × (H - H0)^b */
export function powerFlow(a: number, b: number, h0: number, stageM: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return round(a * Math.pow(Math.max(stageM - h0, 1e-6), b), 2)
}
