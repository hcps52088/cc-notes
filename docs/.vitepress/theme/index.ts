import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () =>
        h('div', { class: 'cc-hero-badge' }, [
          h('span', { class: 'cc-badge-dot' }),
          'Documentation · Active',
        ]),
      'home-features-before': () =>
        h('div', { class: 'cc-stats-bar' },
          h('div', { class: 'cc-stats-inner' }, [
            h('div', { class: 'cc-stat' }, [h('span', { class: 'cc-stat-dot' }), h('span', null, [h('strong', null, '4'), ' 技術模組'])]),
            h('div', { class: 'cc-stat' }, [h('span', { class: 'cc-stat-dot' }), h('span', null, [h('strong', null, '20+'), ' 章節'])]),
            h('div', { class: 'cc-stat' }, [h('span', { class: 'cc-stat-dot' }), '語言：', h('strong', null, '繁體中文')]),
            h('div', { class: 'cc-stat' }, [h('span', { class: 'cc-stat-dot' }), '最後更新：', h('strong', null, '2026-06')]),
          ])
        ),
    })
  },
}
