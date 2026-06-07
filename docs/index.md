---
layout: home

hero:
  name: "CC Notes"
  text: "雲端原生學習筆記"
  tagline: K8s × Rook × Ceph × KubeVirt — 一套 API 統一管理容器與虛擬機
  actions:
    - theme: brand
      text: 整合架構總覽
      link: /integration/
    - theme: alt
      text: 從 K8s 開始
      link: /k8s-01-core-architecture/

features:
  - icon: 🐳
    title: Kubernetes
    details: 核心架構、Networking、Security & RBAC、Helm & GitOps。理解每個元件的設計思路和 Reconciliation Loop。
    link: /k8s-01-core-architecture/
  - icon: 🦑
    title: Ceph
    details: 分散式儲存系統架構、CRUSH 演算法、MON / OSD / MGR 元件、RBD / CephFS / RGW 三種儲存類型。
    link: /ceph-01-architecture/
  - icon: 🪝
    title: Rook
    details: Ceph 的 Kubernetes Operator。用 YAML 部署和管理 Ceph Cluster，整合 CSI Driver 提供 StorageClass。
    link: /rook-01-overview/
  - icon: ⚡
    title: KubeVirt
    details: 在 Kubernetes 上直接跑 VM。架構原理、VM 管理、Storage、Networking、Live Migration。
    link: /kubevirt-01-architecture/
  - icon: 🔗
    title: 整合架構
    details: K8s + Rook/Ceph + KubeVirt 的完整整合方案，從零部署到一個跑在 Ceph 儲存上的虛擬機。
    link: /integration/
  - icon: 📝
    title: 隨堂測驗 & 實作
    details: 每個章節都有測驗題幫你確認學習狀態，以及可以動手跑的實作範例。
    link: /integration/
---
