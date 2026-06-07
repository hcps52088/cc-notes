# K8s 學習筆記

這是一份系統化的 Kubernetes 學習筆記，從有實際使用經驗的角度出發，深入理解每個元件的設計思路。

## 學習路徑

| 章節 | 主題 | 重點 |
|------|------|------|
| 第一章 | [核心架構](01-core-architecture/index.md) | Control Plane、etcd、Reconciliation Loop |
| 第二章 | [Networking](02-networking/index.md) | CNI、Service、Ingress、DNS、NetworkPolicy |
| 第三章 | [Security & RBAC](03-security-rbac/index.md) | ServiceAccount、RBAC、Pod Security |
| 第四章 | [Helm & GitOps](04-helm-gitops/index.md) | Helm chart 設計、ArgoCD、Flux |

## 每章結構

1. **架構圖** — 視覺化元件關係
2. **核心概念** — 每個元件的職責
3. **設計思路** — 為什麼這樣設計
4. **常見陷阱** — 實務上容易踩到的坑
