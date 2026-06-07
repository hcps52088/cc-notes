import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CC Notes',
  description: 'K8s × Rook × Ceph × KubeVirt 雲端原生學習筆記',
  base: '/cc-notes/',
  lang: 'zh-TW',

  themeConfig: {
    siteTitle: 'CC Notes',

    nav: [
      { text: '首頁', link: '/' },
      { text: '🔗 整合架構', link: '/integration/' },
      {
        text: '🐳 Kubernetes',
        items: [
          { text: '核心架構', link: '/k8s-01-core-architecture/' },
          { text: 'Networking', link: '/k8s-02-networking/' },
          { text: 'Security & RBAC', link: '/k8s-03-security-rbac/' },
          { text: 'Helm & GitOps', link: '/k8s-04-helm-gitops/' },
        ]
      },
      {
        text: '🦑 Ceph',
        items: [
          { text: '架構原理', link: '/ceph-01-architecture/' },
          { text: '核心元件深入解析', link: '/ceph-02-components/' },
          { text: '三種儲存類型', link: '/ceph-03-storage-types/' },
        ]
      },
      {
        text: '🪝 Rook',
        items: [
          { text: '架構概覽', link: '/rook-01-overview/' },
          { text: '安裝與設定', link: '/rook-02-installation/' },
        ]
      },
      {
        text: '⚡ KubeVirt',
        items: [
          { text: '架構原理', link: '/kubevirt-01-architecture/' },
          { text: '安裝與設定', link: '/kubevirt-02-installation/' },
          { text: '虛擬機管理', link: '/kubevirt-03-virtual-machines/' },
          { text: 'Storage', link: '/kubevirt-04-storage/' },
          { text: 'Networking', link: '/kubevirt-05-networking/' },
          { text: 'Live Migration', link: '/kubevirt-06-live-migration/' },
        ]
      },
    ],

    sidebar: [
      {
        text: '🔗 整合架構',
        items: [
          { text: 'K8s + Rook + KubeVirt', link: '/integration/' },
        ]
      },
      {
        text: '🐳 Kubernetes',
        collapsed: false,
        items: [
          { text: '核心架構', link: '/k8s-01-core-architecture/' },
          { text: 'Networking', link: '/k8s-02-networking/' },
          { text: 'Security & RBAC', link: '/k8s-03-security-rbac/' },
          { text: 'Helm & GitOps', link: '/k8s-04-helm-gitops/' },
        ]
      },
      {
        text: '🦑 Ceph',
        collapsed: false,
        items: [
          { text: '架構原理', link: '/ceph-01-architecture/' },
          { text: '核心元件深入解析', link: '/ceph-02-components/' },
          { text: '三種儲存類型', link: '/ceph-03-storage-types/' },
        ]
      },
      {
        text: '🪝 Rook',
        collapsed: false,
        items: [
          { text: '架構概覽', link: '/rook-01-overview/' },
          { text: '安裝與設定', link: '/rook-02-installation/' },
        ]
      },
      {
        text: '⚡ KubeVirt',
        collapsed: false,
        items: [
          { text: '架構原理', link: '/kubevirt-01-architecture/' },
          { text: '安裝與設定', link: '/kubevirt-02-installation/' },
          { text: '虛擬機管理', link: '/kubevirt-03-virtual-machines/' },
          { text: 'Storage', link: '/kubevirt-04-storage/' },
          { text: 'Networking', link: '/kubevirt-05-networking/' },
          { text: 'Live Migration', link: '/kubevirt-06-live-migration/' },
        ]
      },
    ],

    search: { provider: 'local' },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hcps52088/cc-notes' }
    ],

    footer: {
      message: '基於 Kubernetes、Ceph、Rook、KubeVirt 官方文件整理',
      copyright: 'Copyright © 2026 hcps52088'
    },

    editLink: {
      pattern: 'https://github.com/hcps52088/cc-notes/edit/main/docs/:path',
      text: '在 GitHub 上編輯此頁'
    },

    lastUpdated: {
      text: '最後更新',
      formatOptions: { dateStyle: 'short', timeStyle: 'short' }
    },

    outline: { label: '本頁目錄', level: [2, 3] },
    docFooter: { prev: '上一頁', next: '下一頁' },
    returnToTopLabel: '回到頂部',
    sidebarMenuLabel: '選單',
    darkModeSwitchLabel: '深色模式',
  },

  markdown: { lineNumbers: true },
  lastUpdated: true,
})
