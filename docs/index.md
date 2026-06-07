---
layout: home

hero:
  name: "CC Notes"
  text: "雲端原生學習文件"
  tagline: "K8s × Rook × Ceph × KubeVirt — 一套 API 統一管理容器與虛擬機"
  actions:
    - theme: brand
      text: 整合架構總覽 →
      link: /integration/
    - theme: alt
      text: 從 K8s 開始
      link: /k8s-01-core-architecture/

features:
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#326ce5"/><text x="20" y="27" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="13">K8s</text></svg>'
    title: "Kubernetes <span class='f-badge stable'>STABLE</span>"
    details: 核心架構、Networking、Security & RBAC、Helm & GitOps。理解每個元件的設計思路與 Reconciliation Loop。
    link: /k8s-01-core-architecture/
    linkText: 開始閱讀
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#e85d04"/><text x="20" y="27" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="12">Ceph</text></svg>'
    title: "Ceph <span class='f-badge stable'>STABLE</span>"
    details: 分散式儲存系統架構、CRUSH 演算法、MON / OSD / MGR 元件解析、RBD / CephFS / RGW 三種儲存類型。
    link: /ceph-01-architecture/
    linkText: 開始閱讀
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#087f5b"/><text x="20" y="27" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="12">Rook</text></svg>'
    title: "Rook <span class='f-badge stable'>STABLE</span>"
    details: Ceph 的 Kubernetes Operator。透過 YAML 部署和管理 Ceph Cluster，整合 CSI Driver 提供 StorageClass。
    link: /rook-01-overview/
    linkText: 開始閱讀
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#6741d9"/><text x="20" y="20" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="10">Kube</text><text x="20" y="31" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="10">Virt</text></svg>'
    title: "KubeVirt <span class='f-badge advanced'>ADVANCED</span>"
    details: 在 Kubernetes 上直接執行 VM。架構原理、VM 管理、Storage、Networking、Live Migration。
    link: /kubevirt-01-architecture/
    linkText: 開始閱讀
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#1971c2"/><text x="20" y="20" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="9">Full</text><text x="20" y="31" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="9">Stack</text></svg>'
    title: "整合架構 <span class='f-badge advanced'>ADVANCED</span>"
    details: K8s + Rook/Ceph + KubeVirt 的完整整合方案，從零部署到一個跑在 Ceph 儲存上的虛擬機。
    link: /integration/
    linkText: 開始閱讀
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#495057"/><text x="20" y="20" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="9">Quiz</text><text x="20" y="31" text-anchor="middle" fill="white" font-family="monospace" font-weight="700" font-size="9">& Lab</text></svg>'
    title: "測驗 & 實作 <span class='f-badge stable'>STABLE</span>"
    details: 每個章節的測驗題幫你確認學習狀態，以及可以動手操作的實作範例。
    link: /integration/
    linkText: 開始練習
---
