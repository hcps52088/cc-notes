---
layout: home

hero:
  name: "Kubernetes"
  text: "學習筆記"
  tagline: 從有使用經驗出發，深入理解每個元件的設計思路
  actions:
    - theme: brand
      text: 開始學習
      link: /01-core-architecture/
    - theme: alt
      text: GitHub
      link: https://github.com/hcps52088/k8s-notes

features:
  - icon: 🏗️
    title: 第一章 核心架構
    details: Control Plane 各元件職責、etcd 的角色、Reconciliation Loop 設計思路，以及一個請求的完整旅程
    link: /01-core-architecture/
  - icon: 🌐
    title: 第二章 Networking
    details: CNI 原理、Service 四種類型、Ingress、CoreDNS、NetworkPolicy，以及 eBPF/Cilium 進階
    link: /02-networking/
  - icon: 🔒
    title: 第三章 Security & RBAC
    details: 認證三道關卡、ServiceAccount、RBAC 完整設計、Pod Security、Secret 管理、Admission Control
    link: /03-security-rbac/
  - icon: 📦
    title: 第四章 Helm & GitOps
    details: Chart 結構、Values 設計、常用指令、ArgoCD Application、Flux、CI/CD 整合流程
    link: /04-helm-gitops/
---
