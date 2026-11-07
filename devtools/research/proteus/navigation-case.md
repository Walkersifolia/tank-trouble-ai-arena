这份记录回答“策略预计能走，实际为什么会卡墙”。本轮已确认一个导航问题：原路径控制会斜切墙端，并在未走完转角时改变航点；正式物理会阻挡车身和炮管。修复了路径的可执行性，没有改游戏的碰撞规则。

证据来自一次隔离的路径跟随复现，不是完整 AI 对局。没有渲染、射击、道具或交战；没有运行价值网络择优、对手预测、完整战术选择或旧脱困流程。因此，下列受阻时间不能当成完整选手的实战卡墙统计。

**源码版本以 Git 为准。**

| 用途 | Git 中的源码 |
| --- | --- |
| 原路径控制，core5 | 927aa98:research/proteus/candidates/proteus-opus-core.js |
| 第一版导航修复，contact1 | 5e2a1e5:research/proteus/candidates/proteus-contact.js |
| 方向相关扫掠修复，integrated3 | eab6960:research/proteus/candidates/proteus-integrated.js |
| 包含最终导航修复的正式选手 | 77f0b3c:bots/astra-g4-proteus.js |

原复现运行时，proteus-contact.js 刚由 Git 927aa98 的 core5 源码创建，尚未修改。contact1 和 integrated3 分别在其修改完成后执行相同路径流程。上述版本之间还有其他策略差异，但本复现只调用外层的 prepare、flood、followField 和 rolloutPlan。正式源码中另有内嵌对手模型；这里调用的是外层函数。

**初始条件与实际结果。**

本例原记录工作目录现统一为 `D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble`。使用正式 ArenaWorld、observe() 和 TankMotion，seed 为 6102，两个参与者，60 Hz，局时限60秒，道具和破墙关闭。两个参与者很重要：地图尺寸随人数变化，这不是同 seed 的三人激光介入地图。

- walker 初始中心 (336,144)，朝向 π/2，屏幕坐标中朝下。
- idle 初始中心 (48,48)，朝向0，全程静止。
- 目标为 (240,240)，相关竖墙为 (288,192)→(288,288)。
- 每 tick 重新生成路径并执行 rolloutPlan 的首个动作，共180 tick，即3秒。
- 墙接触取真实 world.motion.contacts(tank).wall。
- “连续受阻”定义为 abs(move)>0.1 且该 tick 实际中心位移<0.2 px；不是碰撞引擎自带的故障标记。

| 版本 | 180 tick 内墙接触 | 最长连续受阻 | 到达情况 |
| --- | ---: | ---: | --- |
| 原 core5 路径 | 155 tick | 137 tick | 末位置约(295.348,173.196)，距目标86.754 px |
| contact1 路径 | 0 | 0 | tick106输出位置为(240,240)，坐标保留3位小数 |
| integrated3 路径 | 0 | 0 | 成功到达；180 tick 末误差约2.84×10⁻¹⁴ px |

原路径在 tick15 已把第一航点从 (240,144) 改为 (240,240)。tick31 到达约 (299.304,173.668) 时出现真实墙接触，随后航点又在两点间变化，最终持续向墙角发出移动指令。contact1 保留中间转角点，直到 tick43、位置约 (261.461,146.266) 才转向最终目标；tick106 已到达输出精度内的目标。integrated3 保留了这条可执行路线。

各版这个隔离复现的 tank 接触标记均为 false。没有渲染参与，也没有附近坦克推挤。因此，这个案例有证据指向策略导航，不能归因于绘制错位或坦克互推。它没有证明所有实战卡墙都已消除。

**实际执行过的内联命令。**

下面保留 integrated3 那次执行的命令及当时文件路径。它直接加载完整策略源码，再在同一个 VM 中追加 __follow 来访问原有路径函数；没有建立项目测试脚本、框架或门禁。原版和 contact1 的有效命令采用相同方法，加载路径为 research/proteus/candidates/proteus-contact.js，轨迹采样间隔为15 tick，且没有最后的平行墙判定调用。

复用时应从上表对应的 Git 对象取得 source 源码字符串，不能假定当前候选文件仍是当时版本。下面记录的是已经执行过的命令，不代表本次整理文档又运行了它；77f0b3c 是正式源码定位，不是另一次机制复现的结果。

~~~powershell
@'
import { readFileSync } from 'node:fs';import { createContext, Script } from 'node:vm';import { performance } from 'node:perf_hooks';import { ArenaWorld } from './engine/arena/world.js';import { observe } from './engine/arena/observation.js';
const world=new ArenaWorld([{id:'walker',name:'walker',color:'#91a8ff'},{id:'idle',name:'idle',color:'#ff7777'}],{seed:6102,timeout:60,powerups:false,wallBreak:false});
const tank=world.actors.find(a=>a.id==='walker').tank;Object.assign(tank,{x:336,y:144,angle:Math.PI/2});Object.assign(world.actors.find(a=>a.id==='idle').tank,{x:48,y:48,angle:0});
const context=createContext({module:{exports:{}},performance:{now:performance.now.bind(performance)}}),source=readFileSync('research/proteus/candidates/proteus-integrated.js','utf8');
new Script(source+`\nglobalThis.__follow=(state)=>{prepare(state);const plan={aimAngle:null,duel:false};flood(cellIndex(240,240),fieldTarget);followField(plan,fieldTarget,240,240,state.self);rolloutPlan(0,state.self,plan);return {move:candMove[0],turn:candTurn[0],fire:false,special:false,waypoint:pathN?[pathX[0],pathY[0]]:null};};`).runInContext(context,{timeout:250});
const call=new Script('__action=__follow(__state)'),rows=[];let previousWaypoint='',wallTicks=0,maxStill=0,still=0;
for(let i=0;i<180;i++){context.__state=observe(world,'walker');call.runInContext(context,{timeout:50});const a=context.__action,before=[tank.x,tank.y];world.step({walker:a,idle:{move:0,turn:0,fire:false,special:false}});const contacts=world.motion.contacts(tank),wp=JSON.stringify(a.waypoint),moved=Math.hypot(tank.x-before[0],tank.y-before[1]);still=Math.abs(a.move)>.1&&moved<.2?still+1:0;maxStill=Math.max(maxStill,still);wallTicks+=Number(contacts.wall);if(i%30===0||wp!==previousWaypoint)rows.push({tick:i+1,x:+tank.x.toFixed(3),y:+tank.y.toFixed(3),angle:+tank.angle.toFixed(3),move:+a.move.toFixed(3),turn:+a.turn.toFixed(3),waypoint:a.waypoint,contacts});previousWaypoint=wp;}
new Script('globalThis.__parallelClear=clearTankPath(314,210,314,270)').runInContext(context);
console.log(JSON.stringify({kind:'isolated-integrated3-path-controller',seed:6102,goal:[240,240],wallTicks,maxStill,goalDistance:Math.hypot(tank.x-240,tank.y-240),parallel26pxFromWallClear:context.__parallelClear,rows},null,2));
'@ | node --input-type=module -
~~~

**为什么最后采用方向相关的扫掠。**

原导航借用网格射线判断捷径，且以18 px圆形余量近似车辆。网格射线只在跨墙平面附近检查墙所在的行或列，斜向经过墙端时可能漏掉随后进入端角的路段；18 px也没有覆盖完整车角和炮管。

contact1 先按 bodyReach 约31.5 px 向所有方向外扩厚墙，解决了上述墙角复现，但会误拒绝某些可通行路径。例如中心距竖墙26 px、沿墙平移时，车身横向半宽是16 px，炮管半宽是2.5 px，并不需要31.5 px的横向距离。不能从单个墙角通过就推断这种全向膨胀适合全部实战路径。

integrated3 对车身和炮管分别构造沿路径方向平移的扫掠 OBB，并与现有厚墙 AABB 在世界横轴、纵轴、车辆前向和侧向四个轴上做分离轴检测。设路径长度为 L、单位方向为 u、中点为 m：

- 车身扫掠中心为 m，纵向半长为 L/2+bodyHX，横向半宽为 bodyHY。
- 炮管扫掠中心为 m+u×barrelC，纵向半长为 L/2+barrelHX，横向半宽为 barrelHY。
- 轮廓尺寸来自已有公开物理参数及策略的车身、炮管表示；厚墙来自 world.rect。

实际执行的 clearTankPath(314,210,314,270) 返回 true：该线段位于上述竖墙右侧26 px。这里是导航几何判定结果，没有额外声称运行过一场沿墙对局。与此同时，原180 tick墙端复现仍保持0墙接触、0受阻并到达目标。

转角航点也继续保留，但只在实际选中路径候选时跨 tick 延续。完整选手里，chooseMotion 的 ci=0 才来自 rolloutPlan；若改为其他机动或瞄准意图，就清除尚未执行的路径记忆。隔离复现直接执行路径候选，不验证完整选手的机动择优。

**“碰撞计算与实际不一样”的边界。**

导航几何是用于挑选路线的预测。正式 TankMotion 使用车身、炮管轮廓及多车联合 Box2D 接触解算；策略内部 tickTank/resolveBody 则是较便宜的逐步运动和墙接触近似，两者不是同一个求解器。本次没有改正式物理，也没有嵌入整套物理引擎。

最终的扫掠判定描述与路径方向对齐的平移，不是完整转动包络；没有新增倒车时炮管朝向变化的扫掠模型，也没有补上坦克之间的接触预测。转向时的姿态变化和接触偏差仍可能存在。

已有近身失败材料为 development-opus-core-5-vs-opus.json，seed 920101、rotation 0、死亡 tick1471，关键窗口为1450、1460、1470。双方车心约45–47 px，并出现超出名义运动速度的记录，可作为近身预测缺口的研究线索，但日志未记录接触类型；其中 vx/vy 来自前一次物理推进，动作作用于随后一次推进，不能将同一行两者直接当成同 tick 因果，也不能据此断言“已证明互推导致死亡”。

以上导航修复记录仅整理当时已执行的证据。

## 发布后：短暂停车清空脱困计数

用户提供的详细录像 seed 3986024125 记录到：Gen4 在 tick59–141 持续接触墙段 (480,288)→(480,384)，没有坦克接触；起始几何符合右前车身角触及墙端。tick86–119 的前进与原地转向交替，累计路程17.47 px，净移动仅3.95 px。原录像在 tick141 首次倒车，tick142 解除墙接触。

外层 `detectStuck` 要求连续30 tick尝试移动，任何一次 `move=0` 都把计数清零。实际在 tick93 已满足半秒净位移小于7 px，频繁的原地转向却阻止了脱困触发。修改仅将计数上限设为原窗口长度，并在短暂停车时减1；继续使用原脱困候选及风险评分，内嵌对手模型与正式物理未改。

在用户授权的一次定点验证中，用录制动作从初始状态推进，tick93 的坐标和朝向误差均为0。原检测器在0–142窗口内没有触发，新检测器在状态 tick93 触发，建议反向移动。从该实际状态于tick94起执行已有候选 `move=-1, turn=-1`，tick95解除墙接触，至tick105未再次接触。此验证只覆盖检测器和退路的物理可行性，没有运行整局，也不证明完整策略一定选择该候选。264局正式成绩仍对应修正前的冻结版本77f0b3c。

