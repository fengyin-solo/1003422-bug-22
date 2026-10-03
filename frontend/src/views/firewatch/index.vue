<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">维护火险监测点，围绕监测点编号、监测区域、火险等级、风力等级做登记、筛选与状态流转。缺风力或湿度读数时维持原预警，不允许直接解除。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火险监测点</button>
        <button class="btn" type="button" @click="exportRows">导出火险监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">数据缺测/越界：{{ readingIssueCount }}</span>
      <span v-if="pendingCount > 0" class="legend-item">处置面板待续传：{{ pendingCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>数据校验</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="rowIssues(row).length" class="error-text">{{ rowIssues(row).join('；') }}</span>
            <span v-else>读数齐套</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无火险监测数据，可先登记火险监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火险监测记录</span>
      <button v-if="pendingCount > 0" class="link" type="button" @click="flushPending">
        续传 {{ pendingCount }} 条处置面板待办
      </button>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="infoMessage" class="success-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  firewatchReadingInspection,
  listEntries,
  moduleMeta,
  pendingSyncCount,
  resumePendingActions,
  runAction as applyAction,
} from '@/api/local-service'
import { describeIssues, type ReadingInspection } from '@/data/firewatch-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "评估时间", "阈值版本", "监测状态"]
const actions = ["更新等级", "解除预警", "升级预警", "现场复检"]
const statuses = ["正常", "蓝色预警", "黄色预警", "橙色预警", "红色预警"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const pendingCount = ref(0)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const issueCache = new Map<number, ReadingInspection>()

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: "监测点数", value: rows.value.length },
    { label: "红色预警数", value: rows.value.filter((row) => String(row.status) === "红色预警").length },
    {
      label: "今日新增预警",
      value: rows.value.filter(
        (row) =>
          String(row.评估时间 ?? '').startsWith(today) && String(row.status) !== "正常",
      ).length,
    },
  ]
})

const readingIssueCount = computed(() => rows.value.filter((row) => rowIssues(row).length > 0).length)

function rowIssues(row: EntryRow) {
  const cached = issueCache.get(Number(row.id))
  const inspection = cached ?? firewatchReadingInspection(row)
  if (!cached) {
    issueCache.set(Number(row.id), inspection)
  }
  return describeIssues(inspection)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火险监测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  // 带上行版本号：另一监测端先落库时本端会收到冲突，而不是覆盖现场结论。
  const result = applyAction(meta.key, Number(row.id), action, {
    expectedRevision: Number(row.revision ?? 1),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  infoMessage.value = result.message
  reload()
}

function flushPending() {
  errorMessage.value = ''
  const outcome = resumePendingActions()
  infoMessage.value = outcome.resumed === 0
    ? '没有待续传的处置面板上报'
    : `已续传 ${outcome.finished}/${outcome.resumed} 条，剩余受网络影响的会在恢复后自动继续`
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    issueCache.clear()
    pendingCount.value = pendingSyncCount()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

// 另一监测端落库或网络恢复后，本端自动刷新并重新统计待续传数。
function handleExternalChange() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener('online', handleExternalChange)
  window.addEventListener('storage', handleExternalChange)
})

onUnmounted(() => {
  window.removeEventListener('online', handleExternalChange)
  window.removeEventListener('storage', handleExternalChange)
})
</script>
