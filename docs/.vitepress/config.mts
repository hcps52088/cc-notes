import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'K8s & KubeVirt 學習筆記',
  description: 'Kubernetes 核心概念、Networking、Security & RBAC、Helm & GitOps，以及 KubeVirt 虛擬機管理',
  base: '/k8s-notes/',
  lang: 'zh-TW',

  themeConfig: {
    siteTitle: 'K8s & KubeVirt 學習筆記',

    nav: [
      { text: '首頁', link: '/' },
      {
        text: 'Kubernetes',
        items: [
          { text: '第一章 核心架構', link: '/01-core-architecture/' },
          { text: '第二章 Networking', link: '/02-networking/' },
          { text: '第三章 Security & RBAC', link: '/03-security-rbac/' },
          { text: '第四章 Helm & GitOps', link: '/04-helm-gitops/' },
        ]
      },
      {
        text: 'KubeVirt',
        items: [
          { text: '第一章 架構原理', link: '/kubevirt-01-architecture/' },
          { text: '第二章 安裝與設定', link: '/kubevirt-02-installation/' },
          { text: '第三章 虛擬機管理', link: '/kubevirt-03-virtual-machines/' },
          { text: '第四章 Storage', link: '/kubevirt-04-storage/' },
          { text: '第五章 Networking', link: '/kubevirt-05-networking/' },
          { text: '第六章 Live Migration', link: '/kubevirt-06-live-migration/' },
        ]
      },
      { text: 'GitHub', link: 'https://github.com/hcps52088/k8s-notes' },
    ],

    sidebar: [
      {
        text: '🐳 Kubernetes',
        items: [
          {
            text: '第一章 核心架構',
            collapsed: false,
            items: [
              { text: '架構概覽', link: '/01-core-architecture/' },
            ]
          },
          {
            text: '第二章 Networking',
            collapsed: false,
            items: [
              { text: 'CNI、Service、Ingress', link: '/02-networking/' },
            ]
          },
          {
            text: '第三章 Security & RBAC',
            collapsed: false,
            items: [
              { text: 'RBAC、Pod Security', link: '/03-security-rbac/' },
            ]
          },
          {
            text: '第四章 Helm & GitOps',
            collapsed: false,
            items: [
              { text: 'Helm、ArgoCD、Flux', link: '/04-helm-gitops/' },
            ]
          },
        ]
      },
      {
        text: '⚡ KubeVirt',
        items: [
          {
            text: '第一章 架構原理',
            collapsed: false,
            items: [
              { text: '架構概覽', link: '/kubevirt-01-architecture/' },
            ]
          },
          {
            text: '第二章 安裝與設定',
            collapsed: false,
            items: [
              { text: '安裝 KubeVirt', link: '/kubevirt-02-installation/' },
            ]
          },
          {
            text: '第三章 虛擬機管理',
            collapsed: false,
            items: [
              { text: 'VM 與 VMI', link: '/kubevirt-03-virtual-machines/' },
            ]
          },
          {
            text: '第四章 Storage',
            collapsed: false,
            items: [
              { text: 'Disk & Volume 類型', link: '/kubevirt-04-storage/' },
            ]
          },
          {
            text: '第五章 Networking',
            collapsed: false,
            items: [
              { text: 'Interface & Network', link: '/kubevirt-05-networking/' },
            ]
          },
          {
            text: '第六章 Live Migration',
            collapsed: false,
            items: [
              { text: 'Live Migration', link: '/kubevirt-06-live-migration/' },
            ]
          },
        ]
      },
    ],

    search: {
      provider: 'local'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hcps52088/k8s-notes' }
    ],

    footer: {
      message: '基於 Kubernetes 與 KubeVirt 官方文件整理',
      copyright: 'Copyright © 2026 hcps52088'
    },

    editLink: {
      pattern: 'https://github.com/hcps52088/k8s-notes/edit/main/docs/:path',
      text: '在 GitHub 上編輯此頁'
    },

    lastUpdated: {
      text: '最後更新',
      formatOptions: {
        dateStyle: 'short',
        timeStyle: 'short'
      }
    },

    outline: {
      label: '本頁目錄',
      level: [2, 3]
    },

    docFooter: {
      prev: '上一頁',
      next: '下一頁'
    },

    returnToTopLabel: '回到頂部',
    sidebarMenuLabel: '選單',
    darkModeSwitchLabel: '深色模式',
  },

  markdown: {
    lineNumbers: true,
  },

  lastUpdated: true,
})
