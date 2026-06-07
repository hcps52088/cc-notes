---
layout: home

hero:
  name: "K8s & KubeVirt"
  text: "學習筆記"
  tagline: 從有使用經驗出發，深入理解每個元件的設計思路
  actions:
    - theme: brand
      text: K8s 核心架構
      link: /01-core-architecture/
    - theme: alt
      text: KubeVirt 架構
      link: /kubevirt-01-architecture/

features:
  - icon: 🏗️
    title: K8s 核心架構
    details: Control Plane 元件職責、etcd、Reconciliation Loop，以及一個請求的完整旅程
    link: /01-core-architecture/
  - icon: 🌐
    title: K8s Networking
    details: CNI 原理、Service 四種類型、Ingress、CoreDNS、NetworkPolicy、eBPF/Cilium
    link: /02-networking/
  - icon: 🔒
    title: K8s Security & RBAC
    details: 認證三道關卡、ServiceAccount、RBAC、Pod Security、Secret 管理、Admission Control
    link: /03-security-rbac/
  - icon: 📦
    title: K8s Helm & GitOps
    details: Chart 結構、Values 設計、常用指令、ArgoCD、Flux、CI/CD 整合流程
    link: /04-helm-gitops/
  - icon: 💻
    title: KubeVirt 架構原理
    details: virt-api、virt-controller、virt-handler、virt-launcher 元件職責，VM 完整啟動流程
    link: /kubevirt-01-architecture/
  - icon: 🚀
    title: KubeVirt 虛擬機管理
    details: VM vs VMI、RunStrategy、InstanceType、Storage、Networking、Live Migration
    link: /kubevirt-03-virtual-machines/
---
