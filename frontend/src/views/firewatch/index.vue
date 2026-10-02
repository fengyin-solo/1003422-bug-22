<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">维护火险监测点，围绕监测点编号、监测区域、火险等级、风力等级做登记、筛选与状态流转。</p>
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
    </p>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <label v-for="field in columns" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="draft[field]" :placeholder="`请输入${field}`" />
      </label>
      <label class="filter-item">
        <span>初始状态</span>
        <select v-model="draftStatus">
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <div class="create-actions">
        <button class="btn primary" type="submit">提交登记</button>
        <button class="btn ghost" type="button" @click="closeCreate">取消</button>
      </div>
      <p class="create-hint">缺风力或湿度读数、读数越界的监测点不能登记为「正常」；边界由数据服务统一校验，不只靠入口拦截。</p>
    </form>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无火险监测数据，可先登记火险监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火险监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "监测状态"]
const actions = ["更新等级", "解除预警", "升级预警"]
const statuses = ["正常", "蓝色预警", "黄色预警", "橙色预警", "红色预警"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const draft = ref<Record<string, string>>({})
const draftStatus = ref(statuses[0])
const statSource = ref<EntryRow[]>([])

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '监测点数', value: statSource.value.length },
    { label: '红色预警数', value: statSource.value.filter((row) => String(row.status) === '红色预警').length },
    {
      label: '今日新增预警',
      value: statSource.value.filter(
        (row) => String(row.status).includes('预警') && String(row['监测时间'] ?? '') === today,
      ).length,
    },
  ]
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  draft.value = Object.fromEntries(columns.map((field) => [field, '']))
  draftStatus.value = statuses[0]
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
}

function submitCreate() {
  errorMessage.value = ''
  const values = { ...draft.value }
  if (!String(values['监测状态'] ?? '').trim()) {
    values['监测状态'] = draftStatus.value
  }
  const result = createEntry(meta.key, values, draftStatus.value)
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  showCreate.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 带上页面看到的版本号：另一监测端若已改过这条，服务端按冲突拒绝，只落库一条。
  const result = applyAction(meta.key, Number(row.id), action, Number(row.revision ?? 1))
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    statSource.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

onMounted(reload)
</script>
