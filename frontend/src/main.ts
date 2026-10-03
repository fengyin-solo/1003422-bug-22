import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { setupActionRecovery } from './api/recovery'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 网络中断后挂起的处置面板上报，在恢复网络后从未完成步骤继续。
setupActionRecovery()
