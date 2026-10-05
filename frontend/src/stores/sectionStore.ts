/**
 * 断面 store：维护断面测次、垂线集合、测点缓存与录入草稿。
 * 垂线排序按起点距升序，页面展示与流量计算共用同一顺序。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Section } from '@/types/section'
import {
  bankCoefInputToStore,
  createEmptySectionFilter,
  defaultBankCoef,
  resolveSectionBankCoefs,
  type BankCoefSource,
  type SectionFilterState
} from '@/types/section'
import type { Vertical } from '@/types/vertical'
import { buildRelativeDepths } from '@/types/vertical'
import type { Point } from '@/types/point'
import { calcMeanVelocity, calcSectionDischarge, type DischargeResult } from '@/utils/flow'

/** 垂线录入草稿（新增/编辑表单共享结构） */
export interface VerticalDraft {
  no: number
  startDistanceM: number
  depthM: number
  bedNote: string
  /** 测点数：录入测深后按相对水深自动生成测点行 */
  pointCount: number
}

/** 测点录入草稿 */
export interface PointDraft {
  relativeDepth: number
  velocityMs: number
  weight: number
  durationS: number
}

export function createEmptyVerticalDraft(nextNo = 1): VerticalDraft {
  return { no: nextNo, startDistanceM: 0, depthM: 1, bedNote: '', pointCount: 2 }
}

export function createEmptyPointDraft(): PointDraft {
  return { relativeDepth: 0.6, velocityMs: 0.5, weight: 1, durationS: 100 }
}

export const useSectionStore = defineStore('section', () => {
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentSectionId = ref<string | null>(null)
  const currentVerticalId = ref<string | null>(null)
  const filter = ref<SectionFilterState>(createEmptySectionFilter())
  const verticalDraft = ref<VerticalDraft>(createEmptyVerticalDraft())
  const pointDraft = ref<PointDraft>(createEmptyPointDraft())
  /** 批量粘贴文本（跨页面保留录入草稿） */
  const pasteText = ref<string>('')

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
  }

  /** 某测站下的断面测次（按测流时间倒序） */
  function sectionsOfStation(stationId: string | null | undefined): Section[] {
    if (!stationId) return []
    return sections.value
      .filter((section) => section.stationId === stationId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  }

  /** 按筛选条件过滤某测站的断面 */
  const filteredSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => {
        if (currentSectionId.value && section.id === currentSectionId.value) return true
        const keyword = filter.value.keyword.trim()
        if (keyword.length > 0) {
          const haystack = `${section.measureNo}${section.method}`
          if (!haystack.includes(keyword)) return false
        }
        if (filter.value.methods.length > 0 && !filter.value.methods.includes(section.method)) return false
        if (filter.value.minStageM !== null && section.stageM < filter.value.minStageM) return false
        return true
      })
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  const sectionById = (id: string | null | undefined): Section | null =>
    id ? sections.value.find((section) => section.id === id) ?? null : null

  /** 某断面下的垂线：按起点距升序（起点距排序校验的基础） */
  function verticalsOfSection(sectionId: string | null | undefined): Vertical[] {
    if (!sectionId) return []
    return verticals.value
      .filter((vertical) => vertical.sectionId === sectionId)
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
  }

  /** 新建测次未填岸边系数时的默认落库结构：按测法标记默认来源，手填值留空 */
  function defaultBankCoefFields(method: string | null | undefined): Pick<
    Section,
    'leftBankCoef' | 'rightBankCoef' | 'leftBankCoefSource' | 'rightBankCoefSource'
  > {
    const source: BankCoefSource = defaultBankCoef(method) !== null ? 'default' : 'none'
    return { leftBankCoef: null, rightBankCoef: null, leftBankCoefSource: source, rightBankCoefSource: source }
  }

  /**
   * 断面流量成果（统一入口）：按本测次左右岸系数对最左 / 最右垂线折算。
   * 垂线页、测点页、级联重算共用，保证展示值与回写关系点据的值一致。
   */
  function sectionDischarge(section: Section | null | undefined): DischargeResult {
    const rows = section
      ? verticalsOfSection(section.id).map((vertical) => ({
          id: vertical.id,
          no: vertical.no,
          startDistanceM: vertical.startDistanceM,
          depthM: vertical.depthM,
          meanVelocityMs: calcMeanVelocity(
            pointsOfVertical(vertical.id).map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
          )
        }))
      : []
    return calcSectionDischarge(rows, { bankCoefs: section ? resolveSectionBankCoefs(section) : null })
  }

  /** 直读 IndexedDB 计算断面流量（系数刚写入、liveQuery 缓存尚未刷新时用） */
  async function sectionDischargeFromDb(sectionId: string): Promise<DischargeResult> {
    const [section, verticalRows] = await Promise.all([
      db.sections.get(sectionId),
      db.verticals.where('sectionId').equals(sectionId).toArray()
    ])
    const pointRows =
      verticalRows.length > 0 ? await db.points.where('verticalId').anyOf(verticalRows.map((row) => row.id)).toArray() : []
    const rows = verticalRows
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
      .map((vertical) => ({
        id: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        depthM: vertical.depthM,
        meanVelocityMs: calcMeanVelocity(
          pointRows
            .filter((point) => point.verticalId === vertical.id)
            .map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
        )
      }))
    return calcSectionDischarge(rows, { bankCoefs: section ? resolveSectionBankCoefs(section) : null })
  }

  const currentVertical = computed<Vertical | null>(() =>
    currentVerticalId.value
      ? verticals.value.find((vertical) => vertical.id === currentVerticalId.value) ?? null
      : null
  )

  /** 某垂线下的测点：按相对水深升序 */
  function pointsOfVertical(verticalId: string | null | undefined): Point[] {
    if (!verticalId) return []
    return points.value
      .filter((point) => point.verticalId === verticalId)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)
  }

  /** 垂线 id → 测点数与最深水深，供断面列表与垂线页回显 */
  const verticalStats = computed<Record<string, { pointCount: number; depthM: number }>>(() => {
    const stats: Record<string, { pointCount: number; depthM: number }> = {}
    verticals.value.forEach((vertical) => {
      stats[vertical.id] = { pointCount: vertical.pointCount, depthM: vertical.depthM }
    })
    return stats
  })

  /** 断面 id → 垂线条数汇总 */
  const sectionVerticalCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    verticals.value.forEach((vertical) => {
      counts[vertical.sectionId] = (counts[vertical.sectionId] ?? 0) + 1
    })
    return counts
  })

  /** 起点距排序校验：返回重复起点距的垂线号清单 */
  function findDistanceConflicts(sectionId: string): number[] {
    const seen = new Map<number, number>()
    const conflicts: number[] = []
    verticalsOfSection(sectionId).forEach((vertical) => {
      const key = Number(vertical.startDistanceM.toFixed(3))
      if (seen.has(key)) {
        conflicts.push(vertical.no)
      } else {
        seen.set(key, vertical.no)
      }
    })
    return conflicts
  }

  function patchFilter(patch: Partial<SectionFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySectionFilter()
  }

  function selectSection(id: string | null): void {
    currentSectionId.value = id
  }

  function selectVertical(id: string | null): void {
    currentVerticalId.value = id
  }

  function resetVerticalDraft(nextNo = 1): void {
    verticalDraft.value = createEmptyVerticalDraft(nextNo)
  }

  function resetPointDraft(): void {
    pointDraft.value = createEmptyPointDraft()
  }

  /* ------------------------------ 断面测次 ------------------------------ */

  async function createSection(
    payload: Omit<Section, 'id' | 'createdAt' | 'updatedAt' | 'leftBankCoef' | 'rightBankCoef' | 'leftBankCoefSource' | 'rightBankCoefSource'> &
      Partial<Pick<Section, 'leftBankCoef' | 'rightBankCoef' | 'leftBankCoefSource' | 'rightBankCoefSource'>>
  ): Promise<Section> {
    const now = Date.now()
    const defaults = defaultBankCoefFields(payload.method)
    const row: Section = {
      ...payload,
      leftBankCoef: payload.leftBankCoef ?? defaults.leftBankCoef,
      rightBankCoef: payload.rightBankCoef ?? defaults.rightBankCoef,
      leftBankCoefSource: payload.leftBankCoefSource ?? defaults.leftBankCoefSource,
      rightBankCoefSource: payload.rightBankCoefSource ?? defaults.rightBankCoefSource,
      id: createId('sec'),
      createdAt: now,
      updatedAt: now
    }
    await db.sections.put(row)
    return row
  }

  async function updateSection(id: string, patch: Partial<Section>): Promise<void> {
    // 手填系数清空（显式回退到按测法取默认）时，同步把来源标记改回 default/none
    const next: Partial<Section> = { ...patch }
    if (Object.prototype.hasOwnProperty.call(patch, 'leftBankCoef') && patch.leftBankCoef == null) {
      const current = sectionById(id)
      next.leftBankCoefSource = defaultBankCoef(patch.method ?? current?.method) !== null ? 'default' : 'none'
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rightBankCoef') && patch.rightBankCoef == null) {
      const current = sectionById(id)
      next.rightBankCoefSource = defaultBankCoef(patch.method ?? current?.method) !== null ? 'default' : 'none'
    }
    await db.sections.update(id, { ...next, updatedAt: Date.now() } as never)
  }

  /**
   * 保存某测次左右岸岸边流速系数（手填值；空表示未填，按测法取默认）。
   * 系数一动，本测次断面流量、由本测次生成的关系点据与已生成的比测记录一起重算：
   * - 关系点据按「测站 + 测次号」回写实测流量（与水位—流量定线口径一致）；
   * - 关系点据变化后由 ratingStore.rebuildCompares 重算曲线流量、偏差与判定。
   * 返回重算的关系点据条数，供页面提示。
   */
  async function applyBankCoefs(
    id: string,
    inputs: { left: number | null; right: number | null }
  ): Promise<{ section: Section | null; ratingCount: number }> {
    const section = sectionById(id)
    if (!section) return { section: null, ratingCount: 0 }
    const left = bankCoefInputToStore(inputs.left, section.method)
    const right = bankCoefInputToStore(inputs.right, section.method)
    const now = Date.now()
    await db.sections.update(id, {
      leftBankCoef: left.value,
      rightBankCoef: right.value,
      leftBankCoefSource: left.source,
      rightBankCoefSource: right.source,
      updatedAt: now
    } as never)

    // 取最新测次记录（避免依赖尚未刷新的 liveQuery 缓存）
    const fresh = await db.sections.get(id)
    const discharge = await sectionDischargeFromDb(id)
    const ratingIds = await db.ratings
      .where('stationId')
      .equals(section.stationId)
      .filter((rating) => rating.measureNo === section.measureNo)
      .primaryKeys()
    if (ratingIds.length > 0) {
      await db.ratings
        .where('id')
        .anyOf(ratingIds)
        .modify((rating) => {
          rating.flowM3s = discharge.flowM3s
          rating.updatedAt = now
        })
    }
    return { section: fresh ?? section, ratingCount: ratingIds.length }
  }

  async function removeSection(id: string): Promise<void> {
    await db.transaction('rw', [db.sections, db.verticals, db.points], async () => {
      const verticalIds = (await db.verticals.where('sectionId').equals(id).toArray()).map((row) => row.id)
      if (verticalIds.length > 0) {
        await db.points.where('verticalId').anyOf(verticalIds).delete()
        await db.verticals.bulkDelete(verticalIds)
      }
      await db.sections.delete(id)
    })
  }

  /* ------------------------------- 垂线 ------------------------------- */

  async function createVertical(
    sectionId: string,
    payload: Omit<Vertical, 'id' | 'createdAt' | 'updatedAt' | 'sectionId'>
  ): Promise<Vertical> {
    const now = Date.now()
    const row: Vertical = { ...payload, sectionId, id: createId('vrt'), createdAt: now, updatedAt: now }
    await db.verticals.put(row)
    // 录入测深后按相对水深自动生成测点行
    const depths = buildRelativeDepths(payload.pointCount)
    const pointRows: Point[] = depths.map((relativeDepth, index) => ({
      id: createId('pnt'),
      verticalId: row.id,
      relativeDepth,
      velocityMs: 0.5,
      weight: Number((1 / depths.length).toFixed(4)),
      durationS: 100,
      createdAt: now + index,
      updatedAt: now + index
    }))
    if (pointRows.length > 0) await db.points.bulkPut(pointRows)
    return row
  }

  async function updateVertical(id: string, patch: Partial<Vertical>): Promise<void> {
    await db.verticals.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeVertical(id: string): Promise<void> {
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(id).delete()
      await db.verticals.delete(id)
    })
  }

  /** 按测点数重排该垂线的测点行（保持已有流速值，缺失的补默认） */
  async function regeneratePoints(verticalId: string, pointCount: number): Promise<number> {
    const existing = pointsOfVertical(verticalId)
    const depths = buildRelativeDepths(pointCount)
    const now = Date.now()
    const rows: Point[] = depths.map((relativeDepth, index) => {
      const match = existing.find((point) => Math.abs(point.relativeDepth - relativeDepth) < 0.001)
      return {
        id: match?.id ?? createId('pnt'),
        verticalId,
        relativeDepth,
        velocityMs: match?.velocityMs ?? 0.5,
        weight: Number((1 / depths.length).toFixed(4)),
        durationS: match?.durationS ?? 100,
        createdAt: match?.createdAt ?? now + index,
        updatedAt: now + index
      }
    })
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(verticalId).delete()
      if (rows.length > 0) await db.points.bulkPut(rows)
      await db.verticals.update(verticalId, { pointCount: rows.length, updatedAt: now } as never)
    })
    return rows.length
  }

  /* ------------------------------- 测点 ------------------------------- */

  async function createPoint(
    verticalId: string,
    payload: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'verticalId'>
  ): Promise<Point> {
    const now = Date.now()
    const row: Point = { ...payload, verticalId, id: createId('pnt'), createdAt: now, updatedAt: now }
    await db.points.put(row)
    await syncVerticalPointCount(verticalId)
    return row
  }

  async function updatePoint(id: string, patch: Partial<Point>): Promise<void> {
    await db.points.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removePoint(id: string): Promise<void> {
    const point = points.value.find((item) => item.id === id)
    await db.points.delete(id)
    if (point) await syncVerticalPointCount(point.verticalId)
  }

  /** 批量改写某垂线全部测点流速（批量录入） */
  async function bulkSetVelocity(verticalId: string, velocityMs: number): Promise<number> {
    const now = Date.now()
    await db.points
      .where('verticalId')
      .equals(verticalId)
      .modify((point) => {
        point.velocityMs = velocityMs
        point.updatedAt = now
      })
    return pointsOfVertical(verticalId).length
  }

  /** 批量导入解析后的测点草稿（先清空该垂线旧测点行） */
  async function importPointDrafts(
    verticalId: string,
    rows: Array<{ relativeDepth: number; velocityMs: number; durationS: number }>
  ): Promise<number> {
    const now = Date.now()
    const records: Point[] = rows.map((row, index) => ({
      id: createId('pnt'),
      verticalId,
      relativeDepth: row.relativeDepth,
      velocityMs: row.velocityMs,
      weight: Number((1 / rows.length).toFixed(4)),
      durationS: row.durationS,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(verticalId).delete()
      await db.points.bulkPut(records)
      await db.verticals.update(verticalId, { pointCount: records.length, updatedAt: now } as never)
    })
    return records.length
  }

  async function syncVerticalPointCount(verticalId: string): Promise<void> {
    const count = await db.points.where('verticalId').equals(verticalId).count()
    await db.verticals.update(verticalId, { pointCount: count, updatedAt: Date.now() } as never)
  }

  /** 权重归一化：按测点数平均分配计算权重 */
  async function normalizeWeights(verticalId: string): Promise<number> {
    const rows = pointsOfVertical(verticalId)
    if (rows.length === 0) return 0
    const weight = Number((1 / rows.length).toFixed(4))
    await db.points.bulkPut(rows.map((row) => ({ ...row, weight, updatedAt: Date.now() })))
    return rows.length
  }

  return {
    sections,
    verticals,
    points,
    ready,
    error,
    currentSectionId,
    currentVerticalId,
    currentVertical,
    filter,
    filteredSections,
    verticalDraft,
    pointDraft,
    pasteText,
    start,
    sectionsOfStation,
    sectionById,
    verticalsOfSection,
    pointsOfVertical,
    defaultBankCoefFields,
    sectionDischarge,
    sectionDischargeFromDb,
    verticalStats,
    sectionVerticalCounts,
    findDistanceConflicts,
    patchFilter,
    resetFilter,
    selectSection,
    selectVertical,
    resetVerticalDraft,
    resetPointDraft,
    createSection,
    updateSection,
    removeSection,
    applyBankCoefs,
    createVertical,
    updateVertical,
    removeVertical,
    regeneratePoints,
    createPoint,
    updatePoint,
    removePoint,
    bulkSetVelocity,
    importPointDrafts,
    syncVerticalPointCount,
    normalizeWeights
  }
})
