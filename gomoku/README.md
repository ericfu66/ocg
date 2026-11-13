# 弈 · 五子棋人机对弈

一个可以在浏览器里和 AI 下五子棋的网站。AI 使用目前最强的开源五子棋引擎之一 **[Rapfi](https://github.com/dhbloo/rapfi)**（Gomocup 多届冠军），配合官方最新的 **mix9svq NNUE 神经网络权重**。

## 功能

- **三种规则**：自由（五连及以上胜）、标准（恰好五连胜）、连珠（黑方三三/四四/长连禁手，执黑时禁手点自动标 ×）
- **棋盘**：自由规则支持 15 / 19 / 20 路；标准、连珠为 15 路
- **六档难度**：

  | 难度 | 实现方式 | 每步时间 |
  |---|---|---|
  | 新手 | Rapfi `strength=0`：浅层搜索并在候选着法中随机选择 | 0.4 秒 |
  | 入门 | `strength=30` | 0.7 秒 |
  | 业余 | `strength=60` | 1.2 秒 |
  | 高手 | `strength=85`，2 线程 | 2 秒 |
  | 大师 | 全力搜索，全部 CPU 线程 | 5 秒 |
  | **宗师** | **全力搜索 + NNUE + 全部线程 + 大置换表** | 默认 20 秒（可调） |

- 执黑先行 / 执白后行、悔棋、提示（AI 帮你算一步）、认输
- 实时显示 AI 搜索深度、局势评估（胜率条）、搜索速度、主要变化
- 棋谱记录与复制、手数显示、落子音效、手机端"落子确认"防误触
- 本地战绩统计（按难度）、断线自动重连
- 服务端引擎池 + 排队，多人同时访问也不会把服务器压垮

## 技术栈

| 部分 | 技术 |
|---|---|
| AI 引擎 | Rapfi（C++，clang 编译，AVX2/AVX512/NEON）+ mix9svq NNUE 权重 |
| 服务端 | Node.js 22 + `ws`（WebSocket），通过 Piskvork 协议驱动引擎进程 |
| 前端 | 原生 HTML/CSS/JS + Canvas，无构建步骤，无外部 CDN（国内访问快） |
| 部署 | Docker（多阶段构建，构建时联网拉取最新 Rapfi 源码和权重）或 systemd |

为什么把引擎放在服务器上而不是用 WebAssembly 在浏览器里跑？原生编译 + 多线程 + SIMD 的速度是 WASM 的数倍，"宗师"难度才能真正满血，而且手机用户也不需要下载 40 MB 的权重。

```
gomoku/
├── public/              前端（index.html / style.css / app.js）
├── server/              Node.js 服务端（server.js / engine.js）
├── scripts/build-engine.sh   拉取最新 Rapfi + 权重并编译
├── engine/              编译产物（引擎、config.toml、权重；不提交到 git）
├── Dockerfile / docker-compose.yml
└── deploy/              nginx、Caddy、systemd 配置示例
```

---

# 部署指南

## 0. 服务器要求

- **系统**：Ubuntu 22.04/24.04、Debian 12/13 等 64 位 Linux
- **CPU**：x86-64 支持 AVX2（2013 年以后的 Intel/AMD 基本都支持），或 ARM64
  - 建议 **4 核以上**。"宗师"难度的强度和核数基本成正比
- **内存**：2 GB 起步，推荐 4 GB（每个引擎进程约 `HASH_MB` + 100 MB）
- **网络**：构建时需要访问 GitHub 和 Debian/npm 源

检查 CPU 是否支持 AVX2：

```bash
grep -o -w 'avx2\|avx512f\|avx_vnni\|avx512_vnni' /proc/cpuinfo | sort -u
```

## 1. 把代码放到服务器上

```bash
# 在服务器上
sudo apt update && sudo apt install -y git
git clone https://github.com/ericfu66/ocg.git
cd ocg/gomoku
```

（代码在分支 `ccr-48095f55-mhb7r9` 上，如果还没合并到默认分支，克隆后先 `git checkout ccr-48095f55-mhb7r9`。如果仓库是私有的，克隆时用 GitHub 用户名 + Personal Access Token 登录；也可以直接用 `scp -r gomoku 用户@服务器:~/` 上传这个目录。）

## 2. 方式 A：Docker 部署（推荐）

### 2.1 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # 重新登录后生效
```

> 国内服务器如果访问 get.docker.com 或 Docker Hub 很慢，可以用阿里云/腾讯云的 Docker 安装文档和镜像加速器。

### 2.2 选择 CPU 指令集

编辑 `docker-compose.yml` 中的 `CPU_TARGET`：

| 服务器 CPU | CPU_TARGET |
|---|---|
| 不确定 / 一般云服务器 | `avx2`（默认） |
| 支持 `avx512_vnni`（如 Intel 至强 Ice Lake 及以后、AMD Zen4） | `avx512` |
| 支持 `avx_vnni`（Intel 12 代以后消费级） | `avxvnni` |
| ARM 服务器（如 AWS Graviton、阿里云倚天） | `arm64` |

> 选得比 CPU 实际支持的更高，引擎会因"非法指令"崩溃；不确定就用 `avx2`。

### 2.3 构建并启动

```bash
docker compose up -d --build
```

第一次构建会：下载 Debian 编译工具 → 从 GitHub 拉取 **最新** Rapfi 源码与 **最新** 权重（约 40 MB）→ 编译引擎 → 打包 Node.js 服务。大约需要 3~10 分钟。

查看日志，确认引擎加载成功：

```bash
docker compose logs -f
# 应看到： Engine: name="Rapfi", version="0.44.xx ..."
curl http://127.0.0.1:8080/api/health
```

此时网站已在服务器本机 8080 端口运行（compose 默认只监听 127.0.0.1，需要下一步的反向代理才能从外网访问）。如果只是想先用 IP 访问试试，把 `docker-compose.yml` 中的 `"127.0.0.1:8080:8080"` 改成 `"80:8080"`，然后 `docker compose up -d`，浏览器打开 `http://服务器IP` 即可。

### 2.4 以后更新到 Rapfi 最新版本

```bash
git pull
docker compose build --build-arg CACHE_BUST=$(date +%s)
docker compose up -d
```

## 3. 方式 B：不用 Docker（systemd）

```bash
# 1. 安装编译工具和 Node.js 22
sudo apt install -y git cmake make clang libatomic1 curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# 2. 放到 /opt/gomoku
sudo mkdir -p /opt/gomoku && sudo cp -r public server scripts deploy /opt/gomoku/
cd /opt/gomoku

# 3. 编译引擎（native = 自动按本机 CPU 选最快的指令集）
sudo CPU_TARGET=native ./scripts/build-engine.sh /opt/gomoku/engine

# 4. 安装依赖
cd server && sudo npm install --omit=dev && cd ..

# 5. 创建运行用户并注册服务
sudo useradd -r -s /usr/sbin/nologin gomoku || true
sudo chown -R gomoku:gomoku /opt/gomoku
sudo cp deploy/gomoku.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gomoku
sudo journalctl -u gomoku -f        # 查看日志
```

更新引擎：重新执行第 3 步，然后 `sudo systemctl restart gomoku`。

## 4. 配置域名和 HTTPS

先把域名的 A 记录解析到服务器 IP。（国内服务器使用域名需要先完成 ICP 备案。）

### 方案一：Caddy（最简单，自动申请证书）

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/gomoku.example.com/你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 方案二：Nginx + Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/conf.d/gomoku.conf
sudo sed -i 's/gomoku.example.com/你的域名/' /etc/nginx/conf.d/gomoku.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名
```

注意 nginx 配置里的 `Upgrade` / `Connection` 两行是 WebSocket 必需的，不要删。

### 防火墙 / 安全组

在云服务商控制台的安全组里放行 **80** 和 **443** 端口。如果服务器启用了 ufw：

```bash
sudo ufw allow 80,443/tcp
```

完成后访问 `https://你的域名` 即可开始对弈。

## 5. 参数调优

环境变量（在 `docker-compose.yml` 的 `environment` 或 `gomoku.service` 的 `Environment=` 中修改）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `POOL_SIZE` | 2 | 同时搜索的引擎进程数。超过的请求会排队，前端显示排队位置 |
| `THREADS` | CPU 核数 | "大师""宗师"使用的线程数 |
| `HASH_MB` | 512 | 每个引擎的置换表（MB）。内存占用 ≈ (POOL_SIZE) × (HASH_MB + 100) |
| `TOP_TIME_MS` | 20000 | "宗师"每步思考时间（毫秒）。想更强就加大，例如 60000 |
| `MAX_CONN_PER_IP` | 8 | 每个 IP 最多同时连接数 |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | 监听地址 |

建议：

- **个人使用、追求最强**：`POOL_SIZE=1`，`THREADS=全部核数`，`HASH_MB=1024~4096`，`TOP_TIME_MS=30000~60000`
- **公开给很多人玩**：`POOL_SIZE` 设为核数的一半左右，`THREADS=2`，避免一个人用"宗师"占满整台机器

难度档位本身在 `server/server.js` 顶部的 `LEVELS` 数组里，可以自由增删改。

## 6. 常见问题

- **页面显示"已断开，重连中"**：检查反向代理是否配置了 WebSocket（`/ws` 路径），以及 `docker compose logs` 里有无报错。
- **日志里 `illegal instruction` / 引擎反复重启**：`CPU_TARGET` 选高了，改回 `avx2` 重新构建。
- **构建时 `git clone` 很慢或失败（国内服务器）**：可以通过构建参数换成镜像仓库，例如
  `docker compose build --build-arg RAPFI_REPO=https://<镜像>/dhbloo/rapfi --build-arg NETWORKS_REPO=https://<镜像>/dhbloo/rapfi-networks`；
  或者在能访问 GitHub 的机器上用 `scripts/build-engine.sh` 编译好 `engine/` 目录，再拷贝到服务器用方式 B 运行。
- **想用更快的本机指令集**：方式 B 里用 `CPU_TARGET=native`，脚本会自动检测 AVX512/VNNI。

## 致谢与许可

- [Rapfi](https://github.com/dhbloo/rapfi) 引擎 —— GPL-3.0，作者 dhbloo 及贡献者
- [rapfi-networks](https://github.com/dhbloo/rapfi-networks) 权重 —— CC0

本项目以独立进程方式调用 Rapfi，构建时从官方仓库下载源码编译，未修改引擎代码。
