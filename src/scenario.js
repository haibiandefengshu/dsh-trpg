// 内置示例模组：雾港旧宅（原创，六幕）。装完就能玩，也是 scenes 表的用法示例。
export const MODULE_ID = 'mist-harbor';

export const SCENES = [
  {
    moduleId: MODULE_ID, sceneId: 'start', title: '雾港旧宅·门厅',
    desc: '门轴发出一声长叹。挑高的门厅里浮着海腥与霉味，落地钟停在 3:14。左手边是客厅，右侧楼梯通向二楼，走廊尽头有一扇挂着铜牌的门。',
    clues: [
      { id: 'clue_clock', cond: '【侦查】常规检定，或主动检查落地钟', secret: '钟摆背面刻着一行小字：「第三夜，别让它下楼。」' },
      { id: 'clue_letter', cond: '【侦查】常规检定，检查鞋柜', secret: '一封未寄出的信：守夜人提到地下室的排水口每夜会传来敲击声。' },
    ],
    npcs: [],
    exits: [{ sceneId: 'parlor', label: '客厅' }, { sceneId: 'upstairs', label: '二楼楼梯' }, { sceneId: 'cellar_door', label: '走廊尽头的铜牌门' }],
  },
  {
    moduleId: MODULE_ID, sceneId: 'parlor', title: '雾港旧宅·客厅',
    desc: '壁炉冷着，炉膛里堆着没烧完的纸。沙发上方挂着全家福，玻璃裂了，站最右边的人被指甲刮花。',
    clues: [
      { id: 'clue_photo', cond: '【侦查】常规检定，查看全家福', secret: '被刮花的人穿管家制服；背面写「1947 年冬」，但宅子建于 1953 年。' },
      { id: 'clue_burn', cond: '【图书馆】或【神秘学】常规检定，翻检炉膛残页', secret: '残页是一份仪式清单：需要「七个名字」「一只铜铃」「地下室的水」。' },
    ],
    npcs: [],
    exits: [{ sceneId: 'start', label: '门厅' }, { sceneId: 'study', label: '书房' }],
  },
  {
    moduleId: MODULE_ID, sceneId: 'study', title: '雾港旧宅·书房',
    desc: '书架顶到天花板，最下两层空着。桌上摊着一本没合上的账簿，抽屉上了铜锁。窗户被木条从外面钉死。',
    clues: [
      { id: 'clue_drawer', cond: '【锁匠】或【力量】常规检定，撬开抽屉', secret: '抽屉里是一本《守夜日志》，首次翻阅触发 SAN 0/1d4；最后一页写「它已经学会了叫我父亲」。' },
      { id: 'clue_ledger', cond: '【会计】或【侦查】常规检定，核对账簿', secret: '连续十二年每月一笔支出，收款人写着「守夜」。' },
    ],
    npcs: [],
    exits: [{ sceneId: 'parlor', label: '客厅' }, { sceneId: 'upstairs', label: '二楼' }],
  },
  {
    moduleId: MODULE_ID, sceneId: 'upstairs', title: '雾港旧宅·二楼走廊',
    desc: '两侧各有三扇门，只有尽头那扇门缝下透出光。地板在脚下细碎地呻吟，挂画全歪着。',
    clues: [
      { id: 'clue_room', cond: '【聆听】常规检定，贴在尽头那扇门上听', secret: '门后是三下、停、两下的敲击——和信里写的一致。' },
    ],
    npcs: [],
    exits: [{ sceneId: 'start', label: '楼梯 / 门厅' }, { sceneId: 'study', label: '书房' }, { sceneId: 'cellar', label: '二楼暗梯（通往地下室）' }],
  },
  {
    moduleId: MODULE_ID, sceneId: 'cellar_door', title: '雾港旧宅·铜牌门前',
    desc: '铜牌刻着「排水处」。门被挂锁锁着，锁孔里塞着蜡。地板缝隙往外渗凉气，隐约能听到水流声。',
    clues: [
      { id: 'clue_lock', cond: '【锁匠】常规检定，或【力量】困难检定，处理挂锁', secret: '锁能开，但蜡里裹着一小段指骨——开门会惊动下面的东西。' },
    ],
    npcs: [],
    exits: [{ sceneId: 'start', label: '门厅' }, { sceneId: 'cellar', label: '地下室（需先开门）' }],
  },
  {
    moduleId: MODULE_ID, sceneId: 'cellar', title: '雾港旧宅·地下室',
    desc: '半人高的积水漫过脚踝，水面浮着油光。排水口在正中，四周墙上用盐画着圈，圈已经断了两处。',
    clues: [
      { id: 'clue_drain', cond: '【侦查】困难检定，或主动下水摸索排水口', secret: '排水口里卡着一只铜铃，铃舌被拔掉了。' },
      { id: 'clue_final', cond: '集齐「守夜日志」「铜铃」并在盐圈中央摇铃', secret: '摇铃会唤醒「守夜人」：十二年来所有失踪者的聚合体。' },
    ],
    npcs: [{ id: 'E1', name: '守夜人', dex: 55, hp: 15, maxHp: 15, attackSkill: 50, dodgeSkill: 30, damage: '1d6+1d4', armor: 1 }],
    exits: [{ sceneId: 'cellar_door', label: '回到铜牌门' }],
  },
];

export const OPENING =
  '雾港的雾今晚格外低。你们站在旧宅门前，委托人只留了一句话：「第三夜之前，把我父亲从那栋房子里带出来。」\n门没锁。要进去吗？（直接用一句话描述你的行动，不用 @）';


/* ── 第二个内置模组：午夜列车（4 幕）──────────────────────────────── */

export const EXPRESS = {
  moduleId: 'midnight-express',
  title: '午夜列车',
  scenes: [
    {
      moduleId: 'midnight-express', sceneId: 'start', title: '午夜列车·7 号车厢',
      desc: '车窗外没有站台，只有一层不断后退的黑。灯管每 11 秒闪一次，乘客都低着头，没有人说话。乘务员推着餐车从过道尽头过来，轮子没有声音。',
      clues: [
        { id: 'ex_ticket', cond: '【侦查】常规检定，检查你自己的车票', secret: '票面印着今天的日期，但终点站写着「已到达」。' },
        { id: 'ex_passenger', cond: '【心理学】常规检定，观察低头的乘客', secret: '他们的呼吸频率完全一致——这不是六个人，是一个东西的六次呼吸。' },
      ],
      npcs: [],
      exits: [{ sceneId: 'diner', label: '餐车' }, { sceneId: 'conductor', label: '乘务室' }],
    },
    {
      moduleId: 'midnight-express', sceneId: 'diner', title: '午夜列车·餐车',
      desc: '桌上摆着还冒热气的晚餐，刀叉摆得很整齐。墙上时钟指着 23:59 已经很久了。柜台后面有个人在擦杯子，一直没有抬头。',
      clues: [
        { id: 'ex_clock', cond: '【侦查】常规检定，看那只钟', secret: '秒针在倒着走，每次经过 12 就有一只杯子消失。' },
        { id: 'ex_bartender', cond: '【话术】或【恐吓】常规检定，和擦杯子的人说话', secret: '他抬起头：脸是光滑的，没有五官。他说：「你也是被请来的？」' },
      ],
      npcs: [{ id: 'E1', name: '无面侍者', dex: 40, hp: 12, maxHp: 12, attackSkill: 40, dodgeSkill: 20, damage: '1d4', armor: 0 }],
      exits: [{ sceneId: 'start', label: '7 号车厢' }, { sceneId: 'roof', label: '车顶检修口（需要攀爬）' }],
    },
    {
      moduleId: 'midnight-express', sceneId: 'conductor', title: '午夜列车·乘务室',
      desc: '狭小、闷热。墙上钉满了车票，每张都写着同一个名字。控制台上有一根拉杆，标签被撕掉了一半：「紧急…」。',
      clues: [
        { id: 'ex_tickets', cond: '【侦查】常规检定，看墙上的车票', secret: '名字是你自己的。日期从三十年前开始，一年一张，最后一张是今天。' },
        { id: 'ex_lever', cond: '【机械维修】常规检定，检查拉杆', secret: '拉杆连着制动闸，但拉下去会让整列车停在「两站之间」——那里有东西在等。' },
      ],
      npcs: [],
      exits: [{ sceneId: 'start', label: '7 号车厢' }],
    },
    {
      moduleId: 'midnight-express', sceneId: 'roof', title: '午夜列车·车顶',
      desc: '风很大，但吹不动衣角。整列车只有七节车厢，车头没有灯。前方轨道一直延伸到雾里，雾里隐约有站牌的轮廓。',
      clues: [
        { id: 'ex_sign', cond: '【侦查】困难检定，辨认雾里的站牌', secret: '站牌上写着你出生的那条街的名字——这列车正开回你来的地方。' },
        { id: 'ex_end', cond: '带着「三十年的车票」在车顶站定并决定下车', secret: '结局分支：下车＝回到过去但失去记忆；留在车上＝成为下一个乘务员。' },
      ],
      npcs: [],
      exits: [{ sceneId: 'diner', label: '返回餐车' }],
    },
  ],
  opening: '灯管闪了一下。你手里握着一张票，终点站写着「已到达」。\\n车厢里六个人低着头，没有人看你。要做什么？（直接说话，不用 @）',
};

/** 所有内置模组：id → { title, scenes, opening } */
export const MODULES = {
  [MODULE_ID]: { title: '雾港旧宅', scenes: SCENES, opening: OPENING },
  [EXPRESS.moduleId]: { title: EXPRESS.title, scenes: EXPRESS.scenes, opening: EXPRESS.opening },
};

export const MODULE_IDS = Object.keys(MODULES);

/** 取模组的开场白；id 不认识就退回默认模组 */
export function openingOf(moduleId) {
  return (MODULES[moduleId] || MODULES[MODULE_ID]).opening;
}

/** 一个模组的所有场景（用于入库） */
export function scenesOf(moduleId) {
  return (MODULES[moduleId] || MODULES[MODULE_ID]).scenes;
}
