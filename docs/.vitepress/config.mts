import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'K8s 學習筆記',
  description: 'Kubernetes 核心概念、Networking、Security & RBAC、Helm & GitOps',
  base: '/k8s-notes/',
  lang: 'zh-TW',

  themeConfig: {
    siteTitle: 'K8s 學習筆記',

    nav: [
      { text: '首頁', link: '/' },
      {
        text: '學習章節',
        items: [
          { text: '第一章 核心架構', link: '/01-core-architecture/' },
          { text: '第二章 Networking', link: '/02-networking/' },
          { text: '第三章 Security & RBAC', link: '/03-security-rbac/' },
          { text: '第四章 Helm & GitOps', link: '/04-helm-gitops/' },
        ]
      },
      { text: 'GitHub', link: 'https://github.com/hcps52088/k8s-notes' },
    ],

    sidebar: [
      {
        text: '開始學習',
        items: [
          { text: '首頁', link: '/' },
        ]
      },
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
    ],

    search: {
      provider: 'local'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hcps52088/k8s-notes' }
    ],

    footer: {
      message: '基於 Kubernetes 官方文件整理',
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
