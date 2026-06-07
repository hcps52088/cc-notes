# 第二章：Networking

## 整體架構

```
外部流量
    │
    ▼
┌─────────────────────────────────────────┐
│  LoadBalancer / Ingress Controller      │
│  (nginx, traefik, AWS ALB...)           │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Ingress（L7 路由規則）                  │
│  /api  → api-service                    │
│  /web  → web-service                    │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  Service（穩定的 Virtual IP）            │
│  ClusterIP / NodePort / LoadBalancer    │
└─────────────────────────────────────────┘
    │  kube-proxy 維護 iptables 規則
    ▼
┌──────────────────────────────────────────┐
│  Pod（實際跑服務的單位）                  │
│  IP 隨時會變，靠 Service 穩定            │
└──────────────────────────────────────────┘
```

---

## CNI（Container Network Interface）

CNI 是讓 Pod 能互相溝通的底層機制。k8s 本身不管網路實作，只定義介面，由 CNI plugin 負責真正建立網路。

### k8s 對網路的三個核心承諾

1. **Pod 與 Pod 之間可以直接通訊**（跨 Node 也行，不需要 NAT）
2. **Node 可以直接和任何 Pod 通訊**
3. **Pod 看到的自己 IP，和別人看到它的 IP 一樣**（無 NAT）

### 常見 CNI Plugin

| Plugin | 實作方式 | 支援 NetworkPolicy | 適合場景 |
|--------|----------|-------------------|----------|
| **Flannel** | Overlay（VXLAN） | ❌ | 學習環境、簡單場景 |
| **Calico** | BGP / Overlay | ✅ | Production 最常用 |
| **Cilium** | eBPF | ✅ | 高效能、可觀測性強 |
| **Weave** | Overlay + 加密 | ✅ | 多雲、需要加密流量 |
| **Canal** | Flannel + Calico NetworkPolicy | ✅ | 想用 Flannel 但需要 Policy |

### Overlay vs Underlay

- **Overlay**（Flannel、Weave）：把 Pod 封包再包一層，疊在實體網路上。好處是不需要改網路基礎設施，壞處是有額外的封包開銷。
- **Underlay**（Calico BGP）：直接用實體網路路由 Pod IP，效能更好，但對網路設備有要求。

---

## Service

Pod 的生命週期短暫，IP 不固定（重啟、重新調度都會換 IP）。Service 提供一個**穩定的虛擬 IP（ClusterIP）**，負責把流量轉發到背後的 Pod。

### Service 的運作原理

```
Client → ClusterIP（虛擬 IP，不是真實的 NIC）
              │
              │  kube-proxy 在每個 Node 上維護 iptables 規則
              ▼
         隨機選一個健康的 Pod（Round-Robin）
```

kube-proxy 監看 API Server，當 Pod 上下線時，自動更新 iptables / ipvs 規則。

### Service 的四種類型

=== "ClusterIP（預設）"
    只在 cluster 內部可達，外部無法直接存取。大多數內部服務用這個。
    ```yaml
    apiVersion: v1
    kind: Service
    metadata:
      name: my-service
    spec:
      type: ClusterIP
      selector:
        app: my-app
      ports:
        - port: 80          # Service 對外的 Port
          targetPort: 8080  # Pod 實際監聽的 Port
    ```

=== "NodePort"
    在每個 Node 上開一個固定 Port（範圍 30000-32767），外部可透過 `Node IP:NodePort` 存取。開發測試常用，Production 通常用 LoadBalancer。
    ```yaml
    spec:
      type: NodePort
      ports:
        - port: 80
          targetPort: 8080
          nodePort: 30080   # 可以指定，或讓 k8s 自動分配
    ```

=== "LoadBalancer"
    雲端環境（AWS/GCP/Azure）會自動建立外部 Load Balancer，並拿到一個公開 IP。最常用的對外暴露方式。
    ```yaml
    spec:
      type: LoadBalancer
      ports:
        - port: 80
          targetPort: 8080
    # 建立後會在 status 裡拿到外部 IP
    # status:
    #   loadBalancer:
    #     ingress:
    #       - ip: 34.120.x.x
    ```

=== "ExternalName"
    把 Service 名稱對應到外部 DNS，讓 cluster 內的 Pod 用固定名稱存取外部服務，方便遷移和環境切換。
    ```yaml
    spec:
      type: ExternalName
      externalName: my-database.rds.amazonaws.com
    # cluster 內的 Pod 可以直接 curl http://my-service
    # DNS 會解析到 my-database.rds.amazonaws.com
    ```

### Service 如何找到 Pod？靠 Label Selector

Service 持續追蹤符合 selector 的所有 Pod，動態更新 Endpoints 列表：

```yaml
# Service 的 selector
spec:
  selector:
    app: my-app
    env: production

# Pod 的 labels 要完全包含 selector 的所有 key-value
metadata:
  labels:
    app: my-app
    env: production
    version: v1.2.3   # 多的沒關係
```

```bash
# 查看 Service 實際轉發到哪些 Pod
kubectl get endpoints my-service
```

### Headless Service

不要 ClusterIP，讓 DNS 直接回傳所有 Pod IP。用於 StatefulSet（如資料庫、Kafka），讓 client 能直接連特定 Pod。

```yaml
spec:
  clusterIP: None   # 設為 None = Headless
  selector:
    app: my-db
```

---

## Ingress

Service 是 L4（TCP/UDP），只能做 Port-based routing。Ingress 是 L7（HTTP/HTTPS），可以做**基於路徑或 Host 的路由**，一個 LoadBalancer 服務多個應用。

!!! info "Ingress API 已凍結"
    Kubernetes 官方已宣布 Ingress API 凍結（不再新增功能），建議新專案改用 **Gateway API**（`gateway.networking.k8s.io`）。Ingress 本身仍 GA 穩定維護，不會移除。

```
外部請求
    │
    ▼
Ingress Controller（實際跑在 cluster 裡的 Pod，處理流量）
    │  讀取 Ingress 資源定義的路由規則
    ▼
┌─────────────────────────────────────┐
│  myapp.com/api   → api-service      │
│  myapp.com/web   → web-service      │
│  admin.myapp.com → admin-service    │
└─────────────────────────────────────┘
```

!!! warning "Ingress 需要 Ingress Controller"
    建立 Ingress 資源本身沒用，還要在 cluster 裡跑一個 Ingress Controller（nginx、traefik、AWS ALB Controller 等），才會真的處理流量。

### 常見 Ingress Controller

| Controller | 實作 | 特點 | 適合場景 |
|------------|------|------|---------|
| **nginx** | Nginx | 最普遍、功能豐富、穩定 | 大多數場景首選 |
| **traefik** | Traefik | 自動服務發現、有 Dashboard | 動態環境、微服務 |
| **AWS ALB Controller** | AWS Application LB | 原生 AWS 整合、支援 WAF/Shield | AWS 環境 |
| **GCP GKE Ingress** | GCP HTTP(S) LB | GKE 原生、自動管理憑證 | GKE 環境 |
| **Istio Gateway** | Envoy | 流量管理、mTLS、可觀測性 | Service Mesh 場景 |
| **HAProxy** | HAProxy | 極高效能、細粒度設定 | 高流量、金融場景 |

### 範例：路徑 + Host 路由

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - myapp.example.com
      secretName: tls-secret     # 存放 TLS 憑證的 Secret
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-service
                port:
                  number: 80
    - host: admin.example.com    # 不同 subdomain 給不同 service
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: admin-service
                port:
                  number: 80
```

### TLS 終止

TLS 在 Ingress Controller 層解密，後面到 Pod 的流量可以是 HTTP（節省 Pod 的 CPU）：

```bash
# 用 cert-manager 自動申請 Let's Encrypt 憑證
kubectl annotate ingress my-ingress \
  cert-manager.io/cluster-issuer=letsencrypt-prod
```

---

## DNS

k8s 內建 CoreDNS，讓 Pod 用名稱找 Service，不用記 IP。

### DNS 命名規則

```
<service-name>.<namespace>.svc.cluster.local

# 範例
my-service.default.svc.cluster.local
postgres.database.svc.cluster.local
```

### 跨 Namespace 連線

```bash
# 同 Namespace，直接用 Service 名稱
curl http://my-service

# 跨 Namespace，加上 namespace 名稱
curl http://my-service.other-namespace

# 完整 FQDN（防止歧義）
curl http://my-service.other-namespace.svc.cluster.local
```

### Pod 的 DNS 設定

Pod 啟動時，k8s 自動設定 `/etc/resolv.conf`：

```
nameserver 10.96.0.10      # CoreDNS 的 ClusterIP
search default.svc.cluster.local svc.cluster.local cluster.local
```

所以 `curl my-service` 會被展開成 `my-service.default.svc.cluster.local` 來查詢。

### 自訂 DNS

```yaml
spec:
  dnsConfig:
    nameservers:
      - 8.8.8.8
    searches:
      - my-custom.domain
    options:
      - name: ndots
        value: "2"
  dnsPolicy: ClusterFirstWithHostNet
```

---

## NetworkPolicy

預設 k8s 所有 Pod 都可以互相通訊（完全開放）。NetworkPolicy 讓你限制「誰能連到誰」，實現網路層的隔離。

!!! warning "前提：CNI 要支援"
    NetworkPolicy 需要 CNI plugin 支援才有效。Flannel **不支援**；Calico、Cilium、Weave 都支援。

### 設計原則：預設拒絕，明確放行

```yaml
# 第一步：封鎖所有 Ingress 和 Egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}      # 空 selector = 套用到所有 Pod
  policyTypes:
    - Ingress
    - Egress
```

```yaml
# 第二步：放行必要的流量
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-from-frontend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api           # 套用到 api Pod
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: frontend
          podSelector:
            matchLabels:
              app: web   # 只允許 frontend namespace 的 web Pod 進來
      ports:
        - protocol: TCP
          port: 8080
```

### 常見場景：限制 Egress 到特定 IP

```yaml
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8          # 只允許連到內部 IP
            except:
              - 10.0.1.0/24           # 排除特定子網路
      ports:
        - protocol: TCP
          port: 5432                  # 只允許連 PostgreSQL
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53                    # 允許 DNS 查詢
```

---

## NetworkPolicy 規則速查

| 場景 | podSelector | namespaceSelector | ipBlock |
|------|-------------|-------------------|---------|
| 允許同 namespace 所有 Pod | `{}` | 不填 | 不填 |
| 允許特定 label 的 Pod | `matchLabels: {app: web}` | 不填 | 不填 |
| 允許特定 namespace | 不填 | `matchLabels: {name: frontend}` | 不填 |
| 允許外部 IP 範圍 | 不填 | 不填 | `cidr: 203.0.113.0/24` |
| 阻擋所有 | `{}` policyType Ingress（不加 from 欄位） | - | - |

## eBPF 與 Cilium（進階）

傳統 kube-proxy 靠 iptables 做流量轉發，規模大時 iptables 規則會非常龐大，效能下降。

Cilium 用 **eBPF**（extended Berkeley Packet Filter）在 kernel 層做流量處理：

- 效能大幅提升（bypass iptables）
- 支援 L7 NetworkPolicy（可以限制到 HTTP method / path 等級）
- 內建可觀測性（Hubble UI 可以看到所有流量路徑）

```yaml
# Cilium L7 NetworkPolicy 範例
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-get-only
spec:
  endpointSelector:
    matchLabels:
      app: api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: web
      toPorts:
        - ports:
            - port: "8080"
          rules:
            http:
              - method: GET    # 只允許 GET，不允許 POST/DELETE 等
                path: /api/.*
```

---

## 常見陷阱

!!! warning "Service selector 要完全符合"
    Pod 的 labels 必須**完全包含** Service selector 的所有 key-value，少一個就不會被選到，流量打過去 503 但 Service 本身不報錯，很難 debug。
    ```bash
    kubectl get endpoints my-service   # 確認 Endpoints 有沒有 Pod IP
    ```

!!! warning "NodePort 要注意防火牆"
    NodePort 在每個 Node 上開 Port，如果雲端的 Security Group / 防火牆沒有放行那個 Port，外部還是連不到。

!!! warning "Ingress TLS 憑證要放對 Namespace"
    TLS Secret 必須和 Ingress 在同一個 Namespace，跨 Namespace 引用是不行的。

!!! info "kube-proxy 切換到 ipvs 模式"
    大規模 cluster（數千個 Service）建議把 kube-proxy 從 iptables 模式切換到 ipvs 模式，效能差距很大。
    ```yaml
    # kube-proxy ConfigMap
    mode: "ipvs"
    ipvs:
      scheduler: "rr"   # round-robin
    ```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：ClusterIP、NodePort、LoadBalancer 三種 Service type 的使用場景？
**答案：**

| Type | 存取範圍 | 使用場景 |
|------|---------|---------|
| `ClusterIP` | Cluster 內部 | 微服務間通訊（DB、internal API） |
| `NodePort` | 透過 Node IP + Port | 測試環境、沒有 LB 的 on-prem |
| `LoadBalancer` | 外部 IP（雲端 LB） | 生產環境對外服務 |

**Ingress 不是 Service type**，它是一個 L7 Router（HTTP/HTTPS），把多個服務統一在一個入口，用 path/host 分流，只需要一個 LoadBalancer Service。
:::

::: details 測驗 2：Pod-to-Pod 通訊和 Service 通訊的底層機制有什麼不同？
**答案：**

**Pod-to-Pod 直接通訊**（無 NAT）：
- 由 CNI plugin（Calico/Cilium）負責
- 每個 Pod 有唯一 IP，路由規則讓不同 Node 上的 Pod 直接互通
- 不經過 kube-proxy

**Service 通訊（ClusterIP）**：
- 由 kube-proxy 負責（iptables 或 IPVS）
- 當 Pod 連 Service IP:Port，iptables 規則做 DNAT 轉發到其中一個 backend Pod
- Service IP 是虛擬 IP（不真實存在於網卡），只存在 iptables 規則中

**NetworkPolicy** 是在 CNI 層控制的（不是 kube-proxy），規定哪些 Pod 可以連哪些 Pod。
:::

::: details 測驗 3：CoreDNS 如何解析 Service 名稱？`my-svc.my-ns.svc.cluster.local` 各部分代表什麼？
**答案：**

格式：`<service-name>.<namespace>.svc.<cluster-domain>`

- `my-svc`：Service 名稱
- `my-ns`：Namespace
- `svc`：固定字，代表這是 Service 類型的資源
- `cluster.local`：Cluster domain（預設值，可以改）

**簡短形式可用的條件**：
- 同 Namespace：直接用 `my-svc`
- 跨 Namespace：需要 `my-svc.my-ns`（CoreDNS 的 search domain 補全）

CoreDNS 根據 API Server 動態更新 DNS 記錄，Pod 的 `/etc/resolv.conf` 指向 CoreDNS 的 ClusterIP。
:::

---

## 實作：網路排障

```bash
# === 測試 Service DNS 解析 ===
kubectl run dns-test --image=busybox --rm -it -- nslookup kubernetes.default
# 應該解析到 API Server 的 ClusterIP

# === 測試 Service 連通性 ===
kubectl run curl-test --image=curlimages/curl --rm -it -- \
  curl -s http://my-service.my-namespace.svc.cluster.local

# === 查看 Service Endpoints ===
kubectl get endpoints my-service
# 確認 backend Pod IP 有進去

# === 查看 iptables 規則（kube-proxy iptables 模式）===
iptables -t nat -L KUBE-SERVICES | grep my-service
iptables -t nat -L KUBE-SVC-xxxx   # 查看 Service 的 DNAT 規則

# === 查看 NetworkPolicy ===
kubectl get networkpolicy --all-namespaces
kubectl describe networkpolicy my-policy

# === 測試 Pod 間連通性（有 NetworkPolicy 時）===
kubectl exec -it pod-a -- wget -qO- --timeout=3 http://pod-b-ip:8080
# 若超時 = NetworkPolicy 擋住了

# === 查看 Ingress ===
kubectl get ingress --all-namespaces
kubectl describe ingress my-ingress
kubectl -n ingress-nginx get svc   # 查看 Ingress Controller 的外部 IP

# === 模擬 kube-proxy 失效排查 ===
# Service 不通但 Pod 直連 IP 可以 → 通常是 kube-proxy 問題
# 查看 kube-proxy log
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=50
```
