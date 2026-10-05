<script setup lang="ts">
/**
 * 模块 3：/sections/:id/verticals 垂线布设与测深记录
 * 起点距排序校验（重复起点距高亮告警）、按相对水深自动生成测点行、
 * 部分面积法汇总断面流量；深链访问时断面不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import { buildRelativeDepths, type Vertical } from '@/types/vertical'
import {
  BANK_COEF_SOURCE_TEXT,
  defaultBankCoef,
  resolveSectionBankCoefs
} from '@/types/section'
import { calcMeanVelocity } from '@/utils/flow'
import { initDatabase } from '@/utils/db'

const BANK_SOURCE_TEXT = BANK_COEF_SOURCE_TEXT

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()

const sectionId = computed(() => String(route.params.id ?? ''))
const section = computed(() => sectionStore.sectionById(sectionId.value))
const station = computed(() => (section.value ? stationStore.stationById(section.value.stationId) : null))

/** 左右岸岸边流速系数表单：null 表示未填（按测法取默认） */
const coefForm = reactive<{ left: number | null; right: number | null }>({ left: null, right: null })
const savingCoef = ref(false)

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  no: 1,
  startDistanceM: 0,
  depthM: 1,
  pointCount: 2,
  bedNote: ''
})

const verticals = computed(() => sectionStore.verticalsOfSection(sectionId.value))
const conflicts = computed(() => (section.value ? sectionStore.findDistanceConflicts(sectionId.value) : []))

/** 每条垂线的平均流速（按测点权重加权）与单宽流量 */
const verticalRows = computed(() =>
  verticals.value.map((vertical) => {
    const points = sectionStore.pointsOfVertical(vertical.id)
    const meanVelocityMs = calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
    return { vertical, points, meanVelocityMs }
  })
)

/** 断面流量成果：部分面积法 + 岸边流速系数折算（store 统一入口） */
const discharge = computed(() => sectionStore.sectionDischarge(section.value))

/** 左右岸系数解析结果（手填 / 默认 / 不折算） */
const bankCoefs = computed(() => (section.value ? resolveSectionBankCoefs(section.value) : null))

/** 测法默认值（输入框占位与说明用） */
const methodDefault = computed(() => (section.value ? defaultBankCoef(section.value.method) : null))

/** 把测次上手填值同步进表单（测次切换或升级补默认后） */
function syncCoefForm(): void {
  coefForm.left = section.value?.leftBankCoef ?? null
  coefForm.right = section.value?.rightBankCoef ?? null
}

function coefSourceText(side: 'left' | 'right'): string {
  const resolved = bankCoefs.value?.[side]
  return resolved ? BANK_COEF_SOURCE_TEXT[resolved.source] : ''
}

function validateCoef(value: number | null, label: string): boolean {
  if (value === null) return true
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    ElMessage.warning(`${label}岸边流速系数应为 0~1 之间的数字（留空则按测法取默认）`)
    return false
  }
  return true
}

async function saveBankCoefs(): Promise<void> {
  if (!section.value) return
  if (!validateCoef(coefForm.left, '左') || !validateCoef(coefForm.right, '右')) return
  savingCoef.value = true
  try {
    const { section: freshSection, ratingCount } = await sectionStore.applyBankCoefs(section.value.id, {
      left: coefForm.left,
      right: coefForm.right
    })
    // 系数一动，重算受影响关系点据所属定线的比测记录（曲线流量、偏差、判定一起刷新）
    const measureNo = section.value.measureNo
    const stationId = section.value.stationId
    const affectedLines = new Set(
      ratingStore.ratings
        .filter((rating) => rating.stationId === stationId && rating.measureNo === measureNo)
        .map((rating) => rating.lineNo)
    )
    for (const lineNo of affectedLines) {
      await ratingStore.rebuildCompares(lineNo)
    }
    const applied = freshSection ? resolveSectionBankCoefs(freshSection) : bankCoefs.value
    const sideText = (label: string, value: number, source: 'manual' | 'default' | 'none') =>
      `${label} ${value.toFixed(2)}（${BANK_COEF_SOURCE_TEXT[source]}）`
    ElMessage.success(
      `岸边系数已保存：${sideText('左岸', applied?.left.value ?? 1, applied?.left.source ?? 'none')}、` +
        `${sideText('右岸', applied?.right.value ?? 1, applied?.right.source ?? 'none')}；断面流量已重算` +
        `${ratingCount > 0 ? `，并联动刷新 ${ratingCount} 条关系点据` : ''}` +
        `${affectedLines.size > 0 ? `、${affectedLines.size} 条定线的比测记录` : ''}`
    )
  } finally {
    savingCoef.value = false
  }
}

/** 清空某一岸手填值，恢复按测法取默认 */
function clearBankCoef(side: 'left' | 'right'): void {
  coefForm[side] = null
}

/** 岸边垂线行高亮（系数 < 1 时挂暖色） */
function sliceRowClass({ row }: { row: { bankSide: 'left' | 'right' | null; bankCoef: number } }): string {
  if (row.bankSide && row.bankCoef < 1) return 'gb-row-bank'
  return ''
}

/** 表格行系数来源文案（row 在模板里为隐式 any，统一在这里收窄） */
function sliceCoefText(source: 'manual' | 'default' | 'none' | null): string {
  return source ? BANK_SOURCE_TEXT[source] : ''
}

const stats = computed(() => ({
  verticalCount: verticals.value.length,
  pointCount: verticalRows.value.reduce((sum, row) => sum + row.points.length, 0),
  maxDepthM: verticals.value.length ? Math.max(...verticals.value.map((item) => item.depthM)) : 0,
  widthM: discharge.value.widthM
}))

function nextNo(): number {
  const numbers = verticals.value.map((vertical) => vertical.no)
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1
}

function openCreate(): void {
  editingId.value = null
  const last = verticals.value[verticals.value.length - 1]
  form.no = nextNo()
  form.startDistanceM = last ? Number((last.startDistanceM + 6).toFixed(1)) : 0
  form.depthM = last ? last.depthM : 1
  form.pointCount = 2
  form.bedNote = ''
  dialogVisible.value = true
}

function openEdit(vertical: Vertical): void {
  editingId.value = vertical.id
  form.no = vertical.no
  form.startDistanceM = vertical.startDistanceM
  form.depthM = vertical.depthM
  form.pointCount = vertical.pointCount
  form.bedNote = vertical.bedNote
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  if (!Number.isFinite(form.depthM) || form.depthM <= 0) {
    ElMessage.warning('水深应大于 0（m）')
    return
  }
  if (!Number.isInteger(form.pointCount) || form.pointCount < 1 || form.pointCount > 5) {
    ElMessage.warning('测点数应在 1 ~ 5 之间')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await sectionStore.updateVertical(editingId.value, {
        no: form.no,
        startDistanceM: form.startDistanceM,
        depthM: form.depthM,
        bedNote: form.bedNote
      })
      await sectionStore.regeneratePoints(editingId.value, form.pointCount)
      ElMessage.success('垂线已更新，测点行已按相对水深重排')
    } else {
      const created = await sectionStore.createVertical(sectionId.value, {
        no: form.no,
        startDistanceM: form.startDistanceM,
        depthM: form.depthM,
        bedNote: form.bedNote,
        pointCount: form.pointCount
      })
      sectionStore.selectVertical(created.id)
      ElMessage.success(`垂线 ${created.no} 已新增，自动生成 ${created.pointCount} 个测点行`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeVertical(vertical: Vertical): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除垂线 ${vertical.no} 将同时删除其 ${vertical.pointCount} 个流速测点，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeVertical(vertical.id)
  ElMessage.success('垂线及其测点已删除')
}

async function regenerate(vertical: Vertical): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `按当前测点数（${vertical.pointCount}）重新生成测点行？已录入的流速值会按相对水深尽量保留。`,
      '重新生成测点行',
      { type: 'info', confirmButtonText: '重新生成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const depths = buildRelativeDepths(vertical.pointCount)
  const count = await sectionStore.regeneratePoints(vertical.id, depths.length)
  ElMessage.success(`已重新生成 ${count} 个测点行`)
}

function gotoPoints(vertical: Vertical): void {
  sectionStore.selectVertical(vertical.id)
  void router.push(`/verticals/${vertical.id}/points`)
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  ratingStore.start()
  sectionStore.selectSection(sectionId.value)
  syncCoefForm()
})

// 深链切换测次或系数由级联写回后，表单跟随当前测次
watch(
  () => section.value?.id,
  () => syncCoefForm()
)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!sectionStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!section"
      entity-label="断面测次"
      :missing-id="sectionId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        sectionStore.sections.slice(0, 3).map((item) => ({
          id: item.id,
          label: `测次 ${item.measureNo} 的垂线`,
          path: `/sections/${item.id}/verticals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item :to="{ path: `/stations/${section.stationId}/sections` }">
              {{ station?.name ?? '测站' }} 断面测次
            </el-breadcrumb-item>
            <el-breadcrumb-item>垂线布设</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            测次 {{ section.measureNo }} · 垂线布设与测深
            <el-tag size="small" effect="plain">{{ section.method }}</el-tag>
            <el-tag size="small" type="info" effect="plain">水位 {{ section.stageM.toFixed(2) }} m</el-tag>
          </h2>
          <p class="gb-hint">
            录入起点距与水深，测点数决定按相对水深自动生成的测点行（1/2/3/5 点法有预设分布）。垂线按起点距升序参与流量计算。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增垂线</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="垂线条数" :value="stats.verticalCount" suffix="条" icon="Histogram" />
        <StatBadge label="测点合计" :value="stats.pointCount" suffix="点" tone="info" icon="DataLine" />
        <StatBadge label="最大水深" :value="stats.maxDepthM.toFixed(2)" suffix="m" tone="warning" icon="Odometer" />
        <StatBadge label="断面流量" :value="discharge.flowM3s.toFixed(2)" suffix="m³/s" tone="success" icon="TrendCharts" />
      </div>

      <el-alert
        v-if="conflicts.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`起点距排序校验未通过：垂线 ${conflicts.join('、')} 的起点距与其他垂线重复，请调整后再参与流量计算`"
      />

      <el-alert
        v-if="bankCoefs && !bankCoefs.methodKnown"
        type="warning"
        show-icon
        :closable="false"
        title="本测次测法认不出岸边流速系数默认值，左右岸暂不折算（系数按 1.00 计）。请在测次中选用流速仪 / 浮标 / ADCP，或在下方手填系数。"
      />

      <el-card v-if="verticalRows.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>岸边流速系数</h3>
          <span class="gb-hint">
            只压在最左、最右两条垂线各自分担的面积上；中间垂线照原样。留空按测法取默认
            <template v-if="methodDefault !== null">（{{ section?.method }} 默认 {{ methodDefault?.toFixed(2) }}）</template>
          </span>
        </div>
        <div class="page__coef-row">
          <div class="page__coef-item">
            <span class="page__coef-label">左岸系数</span>
            <el-input-number
              v-model="coefForm.left"
              :min="0.01"
              :max="1"
              :step="0.01"
              :precision="2"
              controls-position="right"
              :placeholder="methodDefault !== null ? methodDefault.toFixed(2) : '不折算'"
            />
            <el-tag size="small" :type="coefSourceText('left') === '手填' ? 'warning' : coefSourceText('left') === '不折算' ? 'info' : 'success'" effect="plain">
              {{ coefSourceText('left') }}{{ bankCoefs?.left.defaultValue ? ` ${bankCoefs.left.defaultValue.toFixed(2)}` : '' }}
            </el-tag>
            <el-button v-if="coefForm.left !== null" link type="info" size="small" @click="clearBankCoef('left')">恢复默认</el-button>
          </div>
          <div class="page__coef-item">
            <span class="page__coef-label">右岸系数</span>
            <el-input-number
              v-model="coefForm.right"
              :min="0.01"
              :max="1"
              :step="0.01"
              :precision="2"
              controls-position="right"
              :placeholder="methodDefault !== null ? methodDefault.toFixed(2) : '不折算'"
            />
            <el-tag size="small" :type="coefSourceText('right') === '手填' ? 'warning' : coefSourceText('right') === '不折算' ? 'info' : 'success'" effect="plain">
              {{ coefSourceText('right') }}{{ bankCoefs?.right.defaultValue ? ` ${bankCoefs.right.defaultValue.toFixed(2)}` : '' }}
            </el-tag>
            <el-button v-if="coefForm.right !== null" link type="info" size="small" @click="clearBankCoef('right')">恢复默认</el-button>
          </div>
          <el-button type="primary" :loading="savingCoef" @click="saveBankCoefs">保存并重算断面流量</el-button>
        </div>
        <p class="gb-hint">
          当前采用：左岸系数 {{ discharge.leftBankCoef.toFixed(2) }}（{{ BANK_SOURCE_TEXT[discharge.leftBankCoefSource] }}）、
          右岸系数 {{ discharge.rightBankCoef.toFixed(2) }}（{{ BANK_SOURCE_TEXT[discharge.rightBankCoefSource] }}）
        </p>
      </el-card>

      <EmptyPanel
        v-if="verticalRows.length === 0"
        title="该测次还没有垂线"
        description="新增第一条垂线并录入起点距与水深，系统会按测点数自动生成测点行。"
        action-text="新增垂线"
        @action="openCreate"
      />

      <el-table v-else :data="verticalRows" border stripe class="gb-table-compact">
        <el-table-column label="垂线号" width="90" align="center">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.no }}</span>
            <el-icon v-if="conflicts.includes(row.vertical.no)" class="page__warn"><Warning /></el-icon>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="水深 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.depthM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测点数" width="100" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoPoints(row.vertical)">
              {{ row.points.length }} 点
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="平均流速 (m/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.meanVelocityMs.toFixed(3) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="单宽流量 (m²/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ (row.vertical.depthM * row.meanVelocityMs).toFixed(3) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="vertical.bedNote" label="河床质 / 备注" min-width="170" show-overflow-tooltip />
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoPoints(row.vertical)">测点</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.vertical)">编辑</el-button>
            <el-button size="small" :icon="Refresh" @click="regenerate(row.vertical)">重排</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeVertical(row.vertical)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="verticalRows.length > 0" class="gb-panel">
        <div class="gb-panel-title">
          <h3>部分面积法断面流量成果</h3>
          <span class="gb-hint">
            水面宽 {{ discharge.widthM }} m · 断面面积 {{ discharge.areaM2 }} m² · 平均流速 {{ discharge.meanVelocityMs }} m/s
            <template v-if="discharge.bankAdjusted">
              · 折减前 {{ discharge.rawFlowM3s.toFixed(3) }} m³/s，岸边折算 {{ discharge.bankReducedFlowM3s.toFixed(3) }} m³/s
            </template>
            <template v-else-if="discharge.bankSkipped">· 测法未识别，本测次未做岸边折算</template>
          </span>
        </div>
        <el-table :data="discharge.slices" border size="small" class="gb-table-compact" :row-class-name="sliceRowClass">
          <el-table-column label="垂线号" width="86" align="center">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.no }}</span>
              <el-tag v-if="row.bankSide" size="small" :type="row.bankCoef < 1 ? 'warning' : 'info'" effect="plain" class="page__bank-tag">
                {{ row.bankSide === 'left' ? '左岸' : '右岸' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="部分面积 (m²)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.partialAreaM2.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="岸边系数" width="150" align="center">
            <template #default="{ row }">
              <el-tooltip
                v-if="row.bankCoefSource"
                :content="`${row.bankSide === 'left' ? '左' : '右'}岸系数 ${row.bankCoef.toFixed(2)}（${sliceCoefText(row.bankCoefSource)}）`"
                placement="top"
              >
                <el-tag size="small" :type="row.bankCoefSource === 'manual' ? 'warning' : row.bankCoefSource === 'none' ? 'info' : 'success'" effect="plain">
                  {{ row.bankCoef.toFixed(2) }} · {{ sliceCoefText(row.bankCoefSource) }}
                </el-tag>
              </el-tooltip>
              <span v-else class="gb-hint">—</span>
            </template>
          </el-table-column>
          <el-table-column label="折减前部分流量 (m³/s)" width="180" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.rawPartialFlow.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="折减后部分流量 (m³/s)" width="180" align="right">
            <template #default="{ row }">
              <span class="gb-mono" :class="{ 'page__bank-flow': row.bankCoef < 1 }">{{ row.partialFlow.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="占断面流量" align="right">
            <template #default="{ row }">
              <span class="gb-mono">
                {{ discharge.flowM3s > 0 ? ((row.partialFlow / discharge.flowM3s) * 100).toFixed(1) : '0.0' }}%
              </span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑垂线' : '新增垂线'" width="540px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="垂线号" required>
          <el-input-number v-model="form.no" :min="1" :max="99" controls-position="right" />
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="3000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="水深" required>
          <el-input-number v-model="form.depthM" :min="0.05" :max="80" :step="0.1" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测点数" required>
          <el-radio-group v-model="form.pointCount">
            <el-radio-button v-for="count in [1, 2, 3, 5]" :key="count" :value="count">{{ count }} 点法</el-radio-button>
          </el-radio-group>
          <p class="gb-hint">
            预设相对水深：{{ buildRelativeDepths(form.pointCount).join(' / ') }}
          </p>
        </el-form-item>
        <el-form-item label="河床质 / 备注">
          <el-input v-model="form.bedNote" placeholder="如：主流，砂卵石" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并生成测点' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__warn {
  margin-left: 4px;
  color: #d68910;
  vertical-align: middle;
}

.page__coef-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  margin: 10px 0 6px;
}

.page__coef-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page__coef-label {
  font-size: 13px;
  color: #34506b;
  font-weight: 600;
}

.page__bank-tag {
  margin-left: 4px;
}

.page__bank-flow {
  color: #b9770e;
  font-weight: 700;
}

:deep(.gb-row-bank) {
  background-color: #fdf6e3;
}
</style>
