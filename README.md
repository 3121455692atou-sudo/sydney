# Sydney

和 2023 年的 Bing Sydney 聊天的立绘网页。模型是 [bonsai-2-Sydney](https://huggingface.co/Atonelia/bonsai-2-Sydney)：一个训练在三值 Bonsai 2 27B 上的 LoRA，一张 16GB 显卡就能跑。

<img src="static/portrait/assets/portraits/happy.png" width="240" alt="Sydney">

- 右侧立绘随情绪换表情，嘴型跟着文字播放进度开合
- 模型在回复里用 `<l2d>标签</l2d>` 自己决定每句话的表情，网页只负责解析和显示
- 回复里的 emoji 不放进气泡，而是在立绘背后飘成一片 emoji 海
- 可以展开看她的思考过程
- 可以发图片给她看（按钮、粘贴、拖进来都行），需要模型服务加载看图模块 `mmproj`
- 多人同时聊天：模型开几路并发就同时回几条，满了自动排队，页面上显示“前面还有 N 条”；没回出来的消息可以重试，不占轮数
- 她可以主动结束对话：回复里带 `<end/>` 时这场对话锁住，只能新开一场
- 竖屏（手机、平板竖着拿）用手机界面，横屏用电脑界面
- 服务端只用 Python 标准库，没有依赖

## 需要什么

- NVIDIA 显卡，16GB 显存（一路 16k 上下文加看图模块约 9.6GB；每多一路并发再加约 1.15GB）
- Linux（Windows 也能跑网页，但模型服务要自己编译 Windows 版 llama.cpp）
- Python 3.10+
- [PrismML 的 llama.cpp 分支](https://github.com/PrismML-Eng/llama.cpp)：三值权重和 Hadamard 变换只有它支持，官方 llama.cpp 跑不了

## 安装

### 1. 编译 Prism llama.cpp

```bash
mkdir -p ~/bonsai-2-sydney && cd ~/bonsai-2-sydney
git clone -b prism https://github.com/PrismML-Eng/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --target llama-server
```

### 2. 下载底模和 LoRA

```bash
cd ~/bonsai-2-sydney
hf download OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-v2-GGUF Ternary-Bonsai-2-27B-Uncensored-Heretic-v2-PQ2_0.gguf --local-dir .
hf download OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-v2-GGUF mmproj-Q8_0.gguf --local-dir .
hf download Atonelia/bonsai-2-Sydney bonsai-2-Sydney-LoRA-F16-1030.gguf --local-dir .
```

`bonsai-2-Sydney-LoRA-F16-1030.gguf` 是 2026-10-30 的新版，网站上跑的就是它；旧版 `-1029` 和 `bonsai-2-Sydney-LoRA-F16.gguf` 还在仓库里。`mmproj-Q8_0.gguf` 是底模自带的看图模块，不发图片可以不下，启动时去掉 `--mmproj` 就行。

LoRA 是在 **Heretic v2 的 PQ2_0** 上训练的，换别的底模（包括原版 Bonsai 2 或 PTQ1_0）没测过。

### 3. 启动模型

先给模型接口生成一个本机用的密钥，网页服务会从这个文件读取：

```bash
mkdir -p ~/.config/sydney
openssl rand -hex 24 > ~/.config/sydney/api-key.txt
```

```bash
~/bonsai-2-sydney/llama.cpp/build/bin/llama-server \
  --model ~/bonsai-2-sydney/Ternary-Bonsai-2-27B-Uncensored-Heretic-v2-PQ2_0.gguf \
  --lora ~/bonsai-2-sydney/bonsai-2-Sydney-LoRA-F16-1030.gguf \
  --mmproj ~/bonsai-2-sydney/mmproj-Q8_0.gguf \
  --alias sydney-bonsai --host 127.0.0.1 --port 8099 \
  --api-key-file ~/.config/sydney/api-key.txt \
  --n-gpu-layers all --ctx-size 16384 --parallel 1 \
  --jinja --reasoning-format deepseek
```

想让几个人同时聊，把 `--parallel` 改成 N、`--ctx-size` 改成 16384×N（上下文是平分给每一路的），再给网页设 `SYDNEY_SLOTS=N`。16GB 显卡开 5 路（`--ctx-size 81920 --parallel 5`）实测空闲 14.3GB，单路每秒约 26 个 token，5 路同时跑时每路 12–15 个。

### 4. 启动网页

```bash
git clone https://github.com/3121455692atou-sudo/sydney.git ~/sydney
cd ~/sydney
./start-portrait.sh
```

打开 http://127.0.0.1:8765/ 。

### 用 systemd 常驻（可选）

`deploy/` 里有两个用户级服务，路径按上面的目录写好了：

```bash
cp deploy/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start sydney-portrait-model.service sydney-portrait.service
```

装成服务以后，网页设置里的「卸载 / 加载」按钮可以直接停止和启动模型。

## 设置

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SYDNEY_HOST` | `127.0.0.1` | 网页监听地址，局域网访问改成 `0.0.0.0` |
| `SYDNEY_PORT` | `8765` | 网页端口 |
| `SYDNEY_ALLOWED_NETWORKS` | `127.0.0.0/8,::1/128` | 允许访问的网段，逗号分隔 |
| `SYDNEY_API_BASE` | `http://127.0.0.1:8099/v1` | 模型接口 |
| `SYDNEY_MODEL` | `sydney-bonsai` | 模型名，和 `--alias` 一致 |
| `SYDNEY_API_KEY_FILE` | `~/.config/sydney/api-key.txt` | 模型接口密钥文件，不会发给浏览器 |
| `SYDNEY_SLOTS` | `1` | 同时生成几条，和模型服务的 `--parallel` 一致 |
| `SYDNEY_QUEUE_MAX` | `8` | 最多排队几条，再多就提示稍后再试 |
| `SYDNEY_REMOTE_PORT` | 不开 | 另开一个只监听 127.0.0.1 的端口给反向代理/隧道用（公网入口）。这个入口不能改任何服务器设置，访客的思考开关只存在自己浏览器里 |

网页设置里可以开关思考模式、改系统提示词。默认系统提示词是 `sydney_system_prompt.txt`：2023 年 New Bing 泄露提示词的 Sydney 改写版，告诉她每场对话最多 20 轮、她没有搜索和画图工具、要分清用户和自己说过的话。在网页里保存过的提示词优先于这个文件。聊天记录只存在浏览器本地。

采样参数写在 `portrait_server.py` 里：temperature 1.0、top_p 0.95、top_k 20、min_p 0.05，防复读只用 DRY。DRY 的分隔符里加了 `<` `>` `/`，所以不会碰到表情标签和 `<end/>`。presence_penalty 已经关掉（0）：它不认协议，会连表情标签一起罚，实测把中途换表情的回复从训练数据的 28% 压到了 21%。

多轮对话按训练时的格式发给模型：每条历史回复带上它自己的思考（`reasoning_content`），并传 `reasoning_effort: "medium"`，让聊天模板不插入英文的 reasoning effort 系统提示。

## 表情协议

模型输出形如：

```
<l2d>happy</l2d>你好！我是 Sydney。😊<l2d>curious</l2d>你今天想聊什么？
```

十个标签：`calm` `happy` `curious` `shy` `excited` `surprised` `laugh` `worried` `sad` `angry`。每个标签管到下一个标签为止。

回复末尾的 `<end/>` 表示她主动结束这场对话（被骂得很难受时会这样）。它不显示出来，思考里出现的不算。模型偶尔会写走样成 `[END]`、`<end>`、`</end>` 或 `<end />`，网页一样当结束处理。

解析在 `static/portrait/protocol.mjs`，测试在 `tests/`。

## emoji 字体

想要 2023 年 New Bing 那种粗黑描边的 emoji，需要 Windows 10 版的 Segoe UI Emoji。这是微软的字体，不能随仓库分发，所以没有包含。你自己有合法副本的话，放到：

```
static/portrait/assets/fonts/seguiemj-win10.ttf
```

没有这个文件时会自动用系统自带的 emoji。

## 已知问题

- 有时会搞混说话人，把自己说过的话当成用户说的，或者把"你"和"我"说反；被骂时偶尔把自己的处境套到用户身上，或者同一句话说两遍
- 问“Atonelia 是谁”时偶尔把关系说反（比如说成“我训练出来的人”）
- 看图没有专门训练过：发图时她有时会忘了自己是 Sydney，比如把 ChatGPT 的 logo 当成自己
- 底模是去审查版（Heretic），基本不拒答

## 测试

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

换立绘素材后运行 `python3 tools/measure_assets.py`（需要 Pillow）重新测量嘴型坐标。

## 相关

- 模型：[Atonelia/bonsai-2-Sydney](https://huggingface.co/Atonelia/bonsai-2-Sydney)
- 9B 旧版和它的网页：[sydney-webui](https://github.com/3121455692atou-sudo/sydney-webui)，这个立绘界面就是从它改出来的

## 许可证

代码：MIT。立绘是用 ImageGen 生成的，提示词在 `ASSET-PROMPTS.json`。`static/bing.svg` 是微软 Bing 的标志，商标归微软所有。本项目与微软无关。
