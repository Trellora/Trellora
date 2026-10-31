from pathlib import Path
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Ellipse, Circle
from matplotlib import font_manager

OUT = Path(__file__).resolve().parent / "figures"
OUT.mkdir(parents=True, exist_ok=True)

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]
font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
FP = font_manager.FontProperties(fname=font_path) if font_path else font_manager.FontProperties(family="sans-serif")

COLORS = {
    "ink": "#18322D",
    "muted": "#60736E",
    "line": "#8DA9A1",
    "green": "#26745C",
    "green_light": "#EAF5F0",
    "blue": "#356E9B",
    "blue_light": "#EBF3FA",
    "orange": "#A96327",
    "orange_light": "#FFF3E6",
    "purple": "#72558E",
    "purple_light": "#F3EEF8",
    "paper": "#FBFCFA",
    "white": "#FFFFFF",
}


def text(ax, x, y, value, size=12, color=None, weight="normal", ha="center", va="center", **kwargs):
    return ax.text(x, y, value, fontsize=size, color=color or COLORS["ink"],
                   fontproperties=FP, fontweight=weight, ha=ha, va=va, **kwargs)


def rounded(ax, x, y, w, h, face, edge, radius=0.02, lw=1.4, z=2):
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle=f"round,pad=0.008,rounding_size={radius}",
                         linewidth=lw, edgecolor=edge, facecolor=face, zorder=z)
    ax.add_patch(box)
    return box


def save(fig, stem):
    fig.savefig(OUT / f"{stem}.png", dpi=190, bbox_inches="tight", facecolor=fig.get_facecolor())
    fig.savefig(OUT / f"{stem}.svg", bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def module_diagram():
    fig, ax = plt.subplots(figsize=(18, 12), facecolor=COLORS["paper"])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    text(ax, 0.5, 0.965, "Trellora 用户功能模块示意图", 25, weight="bold")
    text(ax, 0.5, 0.928, "以本地知识工作流为主线 · 当前功能与扩展插件分层呈现", 12, COLORS["muted"])

    rounded(ax, 0.36, 0.825, 0.28, 0.065, COLORS["green"], COLORS["green"], 0.018)
    text(ax, 0.5, 0.857, "本地优先的 AI 知识工作台", 18, COLORS["white"], weight="bold")

    columns = [
        (0.035, "知识记录与组织", COLORS["green"], COLORS["green_light"], [
            ("笔记库与独立文件", "多库管理｜文件树｜最近文件｜草稿恢复"),
            ("Markdown 笔记", "编辑／预览／源码｜自动保存｜导出"),
            ("搜索与知识关联", "关键词／语义／综合检索｜标签｜双向链接"),
        ]),
        (0.278, "资料理解与学习", COLORS["blue"], COLORS["blue_light"], [
            ("资料库与文档流水线", "导入预览｜解析切块｜索引｜取消重试"),
            ("AI 助手与长期记忆", "三种问答范围｜引用｜写作｜会话管理"),
            ("Wiki 学习空间", "章节画布｜节点分析｜派生内容｜转笔记"),
            ("知识图谱", "实体／社区视图｜关系探索｜文档筛选"),
        ]),
        (0.521, "个人效率与扩展", COLORS["orange"], COLORS["orange_light"], [
            ("日程、待办与课表", "四类视图｜重复规则｜提醒｜批量导入"),
            ("内置终端", "多标签 Shell｜快捷呼出｜会话保持"),
            ("插件管理", "安装授权｜启停卸载｜侧栏命令"),
            ("扩展插件", "群务台同步｜音乐榜单速览"),
        ]),
        (0.764, "系统保障与配置", COLORS["purple"], COLORS["purple_light"], [
            ("工作区与数据安全", "备份恢复｜存储迁移｜原文保护"),
            ("模型与外部服务", "生成／向量／重排｜联网｜PDF 解析"),
            ("个性化与记忆治理", "主题语言｜编辑器｜技能｜记忆确认"),
            ("权限与诊断", "插件权限｜能力检查｜日志诊断"),
        ]),
    ]

    for x, title, color, light, items in columns:
        ax.plot([0.5, x + 0.10], [0.825, 0.78], color=COLORS["line"], lw=1.5, zorder=1)
        rounded(ax, x, 0.73, 0.20, 0.055, color, color, 0.014)
        text(ax, x + 0.10, 0.757, title, 15, COLORS["white"], weight="bold")
        n = len(items)
        gap = 0.015
        top = 0.695
        bottom = 0.225
        h = (top - bottom - gap * (n - 1)) / n
        for idx, (name, detail) in enumerate(items):
            y = top - (idx + 1) * h - idx * gap
            rounded(ax, x, y, 0.20, h, light, color, 0.012, 1.1)
            text(ax, x + 0.012, y + h * 0.64, name, 12.2, color, weight="bold", ha="left")
            text(ax, x + 0.012, y + h * 0.32, detail, 8.7, COLORS["muted"], ha="left")

    rounded(ax, 0.07, 0.09, 0.86, 0.075, COLORS["white"], COLORS["line"], 0.014, 1.2)
    text(ax, 0.5, 0.143, "核心知识工作流", 12, COLORS["green"], weight="bold")
    steps = ["收集资料", "解析与索引", "阅读与提问", "整理为笔记", "建立关联", "持续复用"]
    xs = [0.15, 0.29, 0.43, 0.57, 0.71, 0.85]
    for i, (x, label) in enumerate(zip(xs, steps)):
        text(ax, x, 0.113, label, 11.5, weight="bold")
        if i < len(steps) - 1:
            ax.annotate("", xy=(xs[i + 1] - 0.052, 0.113), xytext=(x + 0.052, 0.113),
                        arrowprops=dict(arrowstyle="->", color=COLORS["green"], lw=1.5))

    text(ax, 0.5, 0.045, "说明：基础编辑、文件管理和关键词搜索可离线使用；AI、语义检索、云解析及联网能力取决于相应配置与授权。", 10.5, COLORS["muted"])
    save(fig, "user-functional-modules")


def actor(ax, x, y, label, color):
    ax.add_patch(Circle((x, y + 0.045), 0.012, fill=False, ec=color, lw=1.6, zorder=4))
    ax.plot([x, x], [y + 0.032, y - 0.005], color=color, lw=1.6, zorder=4)
    ax.plot([x - 0.022, x + 0.022], [y + 0.020, y + 0.020], color=color, lw=1.6, zorder=4)
    ax.plot([x, x - 0.018], [y - 0.005, y - 0.035], color=color, lw=1.6, zorder=4)
    ax.plot([x, x + 0.018], [y - 0.005, y - 0.035], color=color, lw=1.6, zorder=4)
    text(ax, x, y - 0.058, label, 10.5, color, weight="bold")


def usecase_diagram():
    fig, ax = plt.subplots(figsize=(19, 13), facecolor=COLORS["paper"])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    text(ax, 0.5, 0.968, "Trellora 用户用例图", 25, weight="bold")
    text(ax, 0.5, 0.934, "普通用户完成知识管理与日程任务，高级用户使用终端和扩展能力", 12, COLORS["muted"])

    rounded(ax, 0.17, 0.07, 0.66, 0.82, COLORS["white"], COLORS["line"], 0.018, 1.5, 1)
    text(ax, 0.5, 0.862, "Trellora 系统边界", 14, COLORS["green"], weight="bold")

    actor(ax, 0.085, 0.58, "普通用户\n（学生／研究者／知识工作者）", COLORS["green"])
    actor(ax, 0.085, 0.25, "高级用户／插件开发者", COLORS["orange"])

    usecases = [
        (0.29, 0.775, "创建与管理笔记库", COLORS["green_light"], COLORS["green"], "user"),
        (0.50, 0.775, "编辑、预览与导出笔记", COLORS["green_light"], COLORS["green"], "user"),
        (0.71, 0.775, "搜索笔记与查看关联", COLORS["green_light"], COLORS["green"], "user"),
        (0.29, 0.655, "导入资料并执行解析索引", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.50, 0.655, "按范围进行 AI 问答", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.71, 0.655, "查看引用并保存回答", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.29, 0.535, "浏览 Wiki 与生成章节", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.50, 0.535, "探索实体关系与社区", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.71, 0.535, "管理记忆与会话历史", COLORS["blue_light"], COLORS["blue"], "user"),
        (0.29, 0.415, "管理事件、待办与课表", COLORS["orange_light"], COLORS["orange"], "user"),
        (0.50, 0.415, "导入课表并设置提醒", COLORS["orange_light"], COLORS["orange"], "user"),
        (0.71, 0.415, "备份、恢复与迁移工作区", COLORS["purple_light"], COLORS["purple"], "user"),
        (0.29, 0.295, "配置模型、隐私与界面", COLORS["purple_light"], COLORS["purple"], "user"),
        (0.50, 0.295, "使用多标签内置终端", COLORS["orange_light"], COLORS["orange"], "advanced"),
        (0.71, 0.295, "安装、授权与管理插件", COLORS["orange_light"], COLORS["orange"], "advanced"),
        (0.39, 0.175, "同步群务台待办与公告", COLORS["orange_light"], COLORS["orange"], "advanced"),
        (0.61, 0.175, "同步音乐榜单速览", COLORS["orange_light"], COLORS["orange"], "advanced"),
    ]

    for x, y, label, face, edge, owner in usecases:
        e = Ellipse((x, y), 0.18, 0.066, facecolor=face, edgecolor=edge, lw=1.3, zorder=3)
        ax.add_patch(e)
        text(ax, x, y, label, 10.5, edge, weight="bold", zorder=4)
        start = (0.115, 0.58 if owner == "user" else 0.25)
        ax.plot([start[0], x - 0.09], [start[1], y], color=edge, alpha=0.38, lw=0.9, zorder=2)

    # External systems and their actual use-case connections.
    external = [
        (0.91, 0.72, "AI／向量模型服务", COLORS["blue"], [(0.59, 0.655), (0.80, 0.775)]),
        (0.91, 0.56, "MinerU／联网搜索", COLORS["blue"], [(0.38, 0.655), (0.59, 0.655)]),
        (0.91, 0.25, "notice-hub 服务", COLORS["orange"], [(0.48, 0.175)]),
        (0.91, 0.12, "网易云公开接口", COLORS["orange"], [(0.70, 0.175)]),
    ]
    for x, y, label, color, targets in external:
        rounded(ax, x - 0.07, y - 0.03, 0.14, 0.06, COLORS["white"], color, 0.01, 1.2, 3)
        text(ax, x, y, label, 10, color, weight="bold")
        for target_x, target_y in targets:
            ax.plot([x - 0.07, target_x], [y, target_y], color=color, alpha=0.55, lw=1.1, ls="--", zorder=2)

    text(ax, 0.5, 0.105, "关键约束：AI 问答需选择数据范围；远程服务需配置与授权；插件仅写入自身来源的数据。", 10.5, COLORS["muted"])
    text(ax, 0.5, 0.035, "注：本图按业务角色划分，不代表系统存在账号、团队权限或管理员后台。", 10.5, COLORS["muted"])
    save(fig, "user-use-case")


if __name__ == "__main__":
    module_diagram()
    usecase_diagram()
    print(f"Generated requirement diagrams in {OUT}")
