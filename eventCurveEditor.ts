import { Coordinate, drawLine, identity, Images, Matrix33, rgb } from "kipphi-player";
import { KPAEvent, SelectState, type LTWH } from "./notesEditor";
import { BezierEasing, BPMEndNode, BPMStartNode, ColorEasedEvaluator, EasedEvaluator, Easing, easingArray, easingMap, Evaluator, EventEndNode, EventNode, EventNodeLike, EventNodeSequence, EventStartNode, EventType, EventValueType, ExpressionEvaluator, fixedEasing, JudgeLine, linearEasing, MacroEvaluator, NodeType, NormalEasing, Note, Op as O, TC, TemplateEasing, type EventValueESType, type EventValueTypeOfType, type NonLastStartNode, type RGB, type SpeedENS, type TimeT } from "kipphi";
import { SelectionManager } from "./selectionManager";
import { drawBezierCurve, getCanvasCoordFromEvent, getOffsetCoordFromEvent, getPercentile, on, type StripReadonly } from "./util";
import { messages } from "./messages";



class KPANodeSelectedEvent extends KPAEvent {
    constructor(public node: EventStartNode<EventValueESType> | EventEndNode<EventValueESType>) {
        super("nodeselected");
    }
}
class KPANodeScopeselectedEvent extends KPAEvent {
    constructor(public nodes: Set<EventStartNode<EventValueESType>>) {
        super("nodescopeselected");
    }
}

class KPABPMAffectedEvent extends KPAEvent {
    constructor() {
        super("bpmaffected");
    }
}

interface KPANodeEventMap {
    "nodeselected": KPANodeSelectedEvent;
    "nodescopeselected": KPANodeScopeselectedEvent;
}


const COLOR_INTERPOLATION_STEP = 0.05;
const COLOR_INTERPOLATION_MAX_STOPS = 20;

const eventTypeMap = [
    { // moveX
        valueGridSpan: 135,
        valueRange: [-675, 675]
    },
    { // moveY
        valueGridSpan: 180,
        valueRange: [-450, 450]
    },
    { // rotate
        valueGridSpan: 90,
        valueRange: [-360, 360]
    },
    { // alpha
        valueGridSpan: 17,
        valueRange: [0, 255]
    },
    { // speed
        valueGridSpan: 2,
        valueRange: [-5, 15]
    },
    { // easing
        valueGridSpan: 270,
        valueRange: [-675, 675]
    },
    { // bpm
        valueGridSpan: 40,
        valueRange: [0, 400]
    },
    { // scaleX
        valueGridSpan: 1,
        valueRange: [-5, 5]
    },
    { // scaleY
        valueGridSpan: 1,
        valueRange: [-5, 5]
    }
] satisfies {valueGridSpan: number, valueRange: [number, number]}[];

type EventTypeName = "moveX" | "moveY" | "alpha" | "rotate" | "speed" | "easing" | "bpm" | "scaleX" | "scaleY" | "text" | "color";
type ExtendedEventTypeName = "scaleX" | "scaleY" | "text" | "color"

export enum NewNodeState {
    controlsStart,
    controlsEnd,
    controlsBoth
}

const eventTypeKeys = ["moveX", "moveY", "alpha", "rotate", "speed", "easing", "bpm", "scaleX", "scaleY", "text", "color"] as const;
const normalTypes = ["moveX", "moveY", "alpha", "rotate", "speed", "easing", "bpm"] as const;
const extendedTypes = ["scaleX", "scaleY", "text", "color"] as const;
const numericEventTypeKeys = ["moveX", "moveY", "alpha", "rotate", "speed", "easing", "bpm", "scaleX", "scaleY"] as const;


type LayerID = "0" | "1" | "2" | "3" | "ex";
type ChangeTargetOptions = { judgeLine?: JudgeLine, layerID?: LayerID };



/**
 * @example
 * 
 * 
    eventSequenceEditors = new EventSequenceEditors(
        eventSequenceEditorCanvas,
        [0, 0, 600, 900],
        operationList
    );
    eventSequenceEditors.changeTarget({ judgeLine: chart.judgeLines[0] });
    // 注意这句，不然容易出错
 */
export class EventSequenceEditors {
    selectState: SelectState;
    timeDivisor: number = 4;


    readonly moveX: NumericEventCurveEditor;
    readonly moveY: NumericEventCurveEditor;
    readonly alpha: NumericEventCurveEditor;
    readonly rotate: NumericEventCurveEditor;
    readonly speed: NumericEventCurveEditor;
    readonly easing: NumericEventCurveEditor;
    readonly bpm: NumericEventCurveEditor;

    readonly text: TextEventSequenceEditor;
    readonly color: ColorEventSequenceEditor;

    readonly scaleX: NumericEventCurveEditor;
    readonly scaleY: NumericEventCurveEditor;

    lastBeats: number;
    easingBeats: number = 0;

    useEasing: Easing = linearEasing;


    constructor(
        public canvas: HTMLCanvasElement,
        public clippingRect: LTWH,
        public readonly operationList: O.OperationList,
        timeBasis: number
    ) {
        this.init(timeBasis || 0);
    }
    init(timeBasis = 0) {
        for (const type of numericEventTypeKeys) {
            (this as StripReadonly<this>)[type] = new NumericEventCurveEditor(EventType[type], this.canvas, this.clippingRect, this.operationList,this);
            this[type].active = false;
            this[type].timeBasis = timeBasis;
        }
        (this as StripReadonly<this>).text = new TextEventSequenceEditor(EventType.text, this.canvas, this.clippingRect, this.operationList, this);
        this.text.timeBasis = timeBasis;
        (this as StripReadonly<this>).color = new ColorEventSequenceEditor(EventType.color, this.canvas, this.clippingRect, this.operationList, this);
        this.color.timeBasis = timeBasis;
        this.bpm.target = this.operationList.chart.timeCalculator.bpmSequence; // 这个不会变
        on(["mousemove", "touchmove"], this.canvas, (event) => {
            this.activatedEditor.moveHandler(event);
            this.draw()
        })
        on(["mousedown", "touchstart"], this.canvas, (event) => {
            this.activatedEditor.downHandler(event)
            this.draw()
        })
        on(["mouseup", "touchend"], this.canvas, (event) => {
            this.activatedEditor.upHandler(event)
            this.draw()
        })
        /*
        this.text = new TextEventSequenceEditor(this.parent.clientHeight - barHeight, this.parent.clientWidth, this);
        this.text.active = false;
        this.color = new ColorEventSequenceEditor(this.parent.clientHeight - barHeight, this.parent.clientWidth, this);
        this.color.active = false;
        */
        this.activatedEditor = this.moveX;
        this.moveX.active = true;

    }
    _selectedEditor: EventSequenceEditor<EventValueESType>;
    get activatedEditor() {
        return this._selectedEditor
    }
    set activatedEditor(val) {
        if (val === this._selectedEditor) return;
        if (this._selectedEditor) this._selectedEditor.active = false;
        this._selectedEditor = val;
        val.active = true;
        this.draw()
    }
    selectedLayer: "0" | "1" | "2" | "3" | "ex" = "0";
    draw(beats?: number) {
        beats = beats || this.lastBeats
        this.lastBeats = beats;
        //console.log("draw")
        if (this.activatedEditor === this.easing) {
            this.easing.draw(this.easingBeats);
        } else {
                
            this.activatedEditor.draw(beats)
        }
    }
    targetLine: JudgeLine;
    changeTarget(options: ChangeTargetOptions) {
        const chart = this.operationList.chart;
        const targetLine = options.judgeLine ?? this.targetLine;
        const targetLayer = options.layerID ?? this.selectedLayer;
        // 速度
        this.speed.targetLine = targetLine;
        this.speed.target =
            targetLine.speedSequence
            ??= chart.createEventNodeSequence(EventType.speed, `#${targetLine.id}.speed`) as SpeedENS;

        const oldTargetLine = this.targetLine;
        const oldSelectedLayer = this.selectedLayer;
            
        this.targetLine = targetLine;
        this.selectedLayer = targetLayer;

        if (targetLayer !== "ex") {
            if (oldSelectedLayer === "ex") {
                this.activatedEditor = this.moveX;
            }
            // 前四个类型
            (["moveX", "moveY", "alpha", "rotate"] as const).forEach((type) => {
                const seq = this[type];
                seq.targetLine = targetLine;
                seq.target =
                    targetLine.eventLayers[targetLayer][type]
                // 这里不要创建序列，因为可能不需要序列
                
            });
        } else {
            if (oldSelectedLayer !== "ex") {
                this.activatedEditor = this.scaleX;
            }
            // 缩放
            (["scaleX", "scaleY"] as const).forEach((type) => {
                const seq = this[type];
                seq.targetLine = targetLine;
                seq.target =
                    targetLine.extendedLayer[type]
                    ??= chart.createEventNodeSequence(EventType[type], `#${targetLine.id}.ex.${type}`);
                // Kipphi 2.x谱面中所有判定线都默认带有缩放序列，但为了兼容性，保留这句。
                // 理论上不需要，因为创建谱面的时候已经补上了这两个序列
                
            });
        
            // 文本
            this.text.targetLine = targetLine;
            this.text.target = targetLine.extendedLayer.text;
            // 这里不要检测不存在创建，因为可能并不需要这么一个序列，而前面几种序列是刚需
            // 颜色事件
            this.color.targetLine = targetLine;
            this.color.target = targetLine.extendedLayer.color;
            // 颜色事件也是，并非刚需
        }

        // BPM和缓动不附着在线上，无需添加其代码
        //*/
        

        
        this.draw()
    }
    
    public buffer: string[] = [];
    notify(str: string) {
        this.buffer.push(str);
    }

    addEventListenerForAll<T extends keyof KPANodeEventMap>(
        type: T,
        listener: (event: KPANodeEventMap[T]) => void, options?: EventListenerOptions): void
    {
        for (const editor of [
            this.moveX,
            this.moveY,
            this.alpha,
            this.rotate,
            this.speed,
            this.easing,
            this.bpm,
            this.text,
            this.color,
            this.scaleX,
            this.scaleY
        ])
        {
            editor.addEventListener(type, listener, options)
        }
    }
}



export enum EventCurveEditorState {
    select,
    selecting,
    edit,
    flowing,
    selectScope,
    selectingScope
}

const lengthOf = (range: readonly [number, number]) => range[1] - range[0];
const medianOf = (range: readonly [number, number]) => (range[0] + range[1]) / 2;
const percentileOf = (range: readonly [number, number], percent: number) => range[0] + lengthOf(range) * percent;
/**
 * 对于一个值，在一系列可吸附值上寻找最接近的值
 * @param sortedAttachable 
 * @param value 
 * @returns 
 */
const computeAttach = (sortedAttachable: number[], value: number) => {
    const len = sortedAttachable.length;
    if (len === 0) return value;
    if (value < sortedAttachable[0]) {
        return sortedAttachable[0];
    }
    for (let i = 0; i < len - 1; i++) {
        const cur = sortedAttachable[i];
        if (value === cur) {
            return cur;
        }
        const next = sortedAttachable[i + 1];
        if (value > cur && value < next) {
            return (value - cur) < (next - value) ? cur : next;
        }
    }
    if (value > sortedAttachable[len - 1]) {
        return sortedAttachable[len - 1];
    }
}
/**
 * 生成可吸附值
 * @param linear 一次函数的两个系数
 * @param range 显示范围
 */
function generateAttachable (linear: [k: number, b: number], range: readonly [number, number])  {
    const k = linear[0], b = linear[1];
    const left = range[0], right = range[1];
    if (k <= 1e-6) {
        return [left, b, right];
    }
    const startingX = Math.floor((left - b) / k);
    const attachable: number[] = [];
    for (let i = startingX; ; i++) {
        const val = k * i + b;
        attachable.push(k * i + b);
        if (val > right) break;
    }
    return attachable;
}

function divideOrMul(gridSpan: number, maximum: number)  {
    const m = Math.floor(maximum);
    if (m === 0) {
        const times = Math.floor(1 / maximum);
        return gridSpan * times;
    }
    if (isNaN(gridSpan) || isNaN(m)) { debugger;}
    if (!Number.isInteger(gridSpan)) {
        return gridSpan / m;
    } else {
        // 有的时候maximum莫名其妙整的特大，采取这种方式
        if (gridSpan < maximum) {
            return 1;
        }
        for (let i = m; i >= 1; i--) {
            if (gridSpan % i === 0) {
                return gridSpan / i;
            }
        }
        return gridSpan;
    }
}



/**
 * 事件序列编辑器基类。
 * 
 * 简单介绍三个矩阵：
 * - `matrix`: 用于事件实际值到编辑器坐标转换（仅`NumericEventCurveEditor`使用）
 * - `canvasMatrix`：用于编辑器坐标到Canvas坐标转换，该矩阵等价于`context.getTransform()`
 * - `elementMatrix`：用于元素`offsetX`/`offsetY`到Canvas坐标的转换。（即，有时候Canvas的`width`和`height`不为物理大小）
 * 
 * 
 */
export abstract class EventSequenceEditor<VT extends EventValueESType> extends EventTarget {
    readonly valueType: EventValueTypeOfType<VT>;

    targetLine: JudgeLine;
    target: EventNodeSequence<VT>;
    targetEasing?: TemplateEasing;

    innerHeight: number;
    innerWidth: number;

    nodeHeight = 30;
    nodeWidth = 30;


    readonly context: CanvasRenderingContext2D;
    timeRatio: number;

    timeSpan: number;
    timeGridInterval: number;
    /** [-0.5, 0.5] */
    timeBasis: number = 0;



    timeGridColor = "rgb(120, 255, 170)";

    
    /** 用于范围选取框的颜色 */
    scopingColor = "#FAA";

    padding: number;


    state: EventCurveEditorState;


    _selectedNode: WeakRef<EventStartNode | EventEndNode>;

    newNodeState: NewNodeState = NewNodeState.controlsBoth;
    selectState: SelectState;
    lastSelectState: SelectState = SelectState.extend;


    selectedNode: EventStartNode<VT> | EventEndNode<VT> = null;

    autoRangeEnabled: boolean = true;


    active = false;


    clipboard: Set<EventStartNode<VT>> = new Set();
    nodesSelection: Set<EventStartNode<VT>> = new Set();

    
    constructor(
        public readonly type: EventType,
        
        public readonly canvas: HTMLCanvasElement,
        public clippingRect: LTWH,
        public readonly operationList: O.OperationList,
        public readonly parentEditorSet: EventSequenceEditors
    ) {
        super();
        if (type === EventType.alpha) {
            this.autoRangeEnabled = false;
        }
        this.state = EventCurveEditorState.select


        this.selectionManager = new SelectionManager()


        this.padding = 14;
        this.innerHeight = clippingRect[3] - this.padding * 2;
        this.innerWidth = clippingRect[2] - this.padding * 2;

        this.elementMatrix = identity
            .scale(this.canvas.clientWidth / this.canvas.width, this.canvas.clientHeight / this.canvas.height);
        this.elementMatrixInverted = this.elementMatrix.invert();

        const resizeObserver = new ResizeObserver(() => {
            this.elementMatrix = identity
                .scale(this.canvas.clientWidth / this.canvas.width, this.canvas.clientHeight / this.canvas.height);
            this.elementMatrixInverted = this.elementMatrix.invert();
        });
        resizeObserver.observe(this.canvas);

        this.context = this.canvas.getContext("2d");
        this.context.font = "30px Phigros"


        this.timeSpan = 4
        this.timeRatio = this.innerHeight / this.timeSpan;
        this.timeGridInterval = 1;
        this.initContext()

        
        // 下面有一堆监听器
        // #region
        

        

    
        this.mouseIn = false;
        this.canvas.addEventListener("mouseenter", () => {
            this.mouseIn = true;
        });
        this.canvas.addEventListener("mouseleave", () => {
            this.mouseIn = false;
        });
        
        window.addEventListener("keydown", (e: KeyboardEvent) => { // 踩坑：Canvas不能获得焦点
            if (!this.mouseIn || !this.active) {
                return;
            }
            if (document.activeElement !== document.body) {
                return;
            }
            e.preventDefault();
            if (e.key === "Shift") {
                if (this.state === EventCurveEditorState.selectScope || this.state === EventCurveEditorState.selectingScope) {
                    return;
                }
                this.state = EventCurveEditorState.selectScope;
                this.selectState = this.lastSelectState;
                this.draw();
                return;
            }
            switch (e.key.toLowerCase()) {
                case "v":
                    this.paste();
                    break;
                case "c":
                    this.copy();
                    break;
                case "r":
                    if (e.ctrlKey) {
                        return;
                    }
                    this.placeNode(
                        this instanceof NumericEventCurveEditor
                            ? this.pointedValue as VT
                        : null
                    )
            }
        })
        window.addEventListener("keyup", (e: KeyboardEvent) => {
            if (!this.active) {
                return;
            }
            if (e.key === "Shift") {
                if (this.state === EventCurveEditorState.selectScope || this.state === EventCurveEditorState.selectingScope) {
                    this.state = EventCurveEditorState.select;
                    this.selectState = SelectState.none;
                    this.draw();
                }
            }
        })
        // #endregion
        
    }
    override addEventListener<T extends keyof KPANodeEventMap>(
        type: T,
        listener: (event: KPANodeEventMap[T]) => void, 
        options?: EventListenerOptions
    ): void 
    {
        super.addEventListener(type, listener, options);
    }


        
    updateMatrix() {
        this.canvasMatrix = Matrix33.fromDOMMatrix(this.context.getTransform());
        this.canvasMatrixInverted = this.canvasMatrix.invert();
    }
    abstract moveHandler(event: MouseEvent | TouchEvent): void;
    abstract downHandler(event: MouseEvent | TouchEvent): void;
    abstract upHandler(event: MouseEvent | TouchEvent): void;

    placeNode(value: VT) {
        const time: TimeT = this.pointedTime;
        const prev = this.target.getNodeAt(TC.toBeats(time))
        if (TC.eq(prev.time, time)) {
            return;
        }
        value = value ?? prev.value;
        let node: EventStartNode<VT>, endNode: EventEndNode<VT>;
        if (this.type === EventType.bpm) {
            (node as any as BPMStartNode) = new BPMStartNode(time, value as number);
            (endNode as any as BPMEndNode) = new BPMEndNode(time);
        } else {
            endNode = new EventEndNode(time, this.newNodeState === NewNodeState.controlsStart ? prev.value : value)
            node = new EventStartNode(time, this.newNodeState === NewNodeState.controlsEnd ? prev.value : value);
        }
        node.evaluator = EasedEvaluator.getEvaluatorFromEasing<VT>(this.valueType, this.parentEditorSet.useEasing) as unknown as EasedEvaluator<VT>;
        EventNode.connect(endNode, node)
        // this.editor.chart.getComboInfoEntity(startTime).add(note)
        this.operationList.do(new O.EventNodePairInsertOperation(node, prev));
        if (this.type === EventType.bpm) {
            this.dispatchEvent(new KPABPMAffectedEvent());
        }
        this.selectedNode = node;
    }

    

    initContext() {
        const centerX = this.clippingRect[0] + this.clippingRect[2] / 2;
        const centerY = this.clippingRect[1] + this.clippingRect[3] / 2;
        this.context.setTransform(1, 0, 0, 1, centerX, centerY);
        // a c e
        // b d f
        this.context.strokeStyle = "#EEE"
        this.context.fillStyle = "#333"
        this.context.lineWidth = 2
    }
    drawCoordination(beats: number) {
        const [boundLeft, boundTop, boundWidth, boundHeight] = this.clippingRect;
        const {innerHeight, innerWidth} = this;
        const {
            timeGridInterval: timeGridSpan,
            timeRatio, context, timeBasis} = this;
        
        const timeDivisor = this.parentEditorSet.timeDivisor
        context.clearRect(-boundWidth / 2, -boundHeight / 2, boundWidth, boundHeight)
        context.fillStyle = "#333d";
        context.fillRect(-boundWidth / 2, -boundHeight / 2, boundWidth, boundHeight)
        // const beatCents = beats * 100
        // const middleValue = Math.round(-this.basis / this.valueRatio)
        // const basis = -medianOf(valueRange) / lengthOf(valueRange) * this.innerHeight;
        // 计算上下界
        context.save()
        context.fillStyle = "#EEE"
        context.font = "30px phigros"
        const textPosX = -this.innerWidth / 2 + 10;
        const canvasPoint = this.canvasPoint;
        if (canvasPoint) {
            this.context.fillText(`Cursor: ${canvasPoint.x.toFixed(3)}, ${canvasPoint.y.toFixed(3)}`, textPosX, -150)
        }
        context.fillText("Sequence: " + this.target.id, textPosX, -120)
        context.fillText("State: " + EventCurveEditorState[this.state], textPosX, -90)
        context.fillText("Beats: " + beats.toFixed(4), textPosX, -60)
        const pointedTime = this.pointedTime;
        if (pointedTime) {
            context.fillText(`pointedTime: ${pointedTime[0]}:${pointedTime[1]}/${pointedTime[2]}`, textPosX, -30);
        }
        context.restore()
        context.save()
        context.strokeStyle = this.timeGridColor;
        context.fillStyle = this.timeGridColor;

        context.lineWidth = 3;
        
        const yZero = innerHeight * timeBasis;
        const stopBeats = Math.ceil((beats + this.timeSpan * (0.5 + timeBasis)) / timeGridSpan) * timeGridSpan;
        const startBeats = Math.ceil((beats + this.timeSpan * (-0.5 + timeBasis)) / timeGridSpan - 1) * timeGridSpan;
        for (let time = startBeats; time < stopBeats; time += timeGridSpan) {
            const positionY = (time - beats)  * timeRatio - yZero;
            drawLine(context, innerWidth / 2, -positionY, -innerWidth / 2, -positionY);
            context.fillText(time + "", -innerWidth / 2 + 10, -positionY)

            
            context.save()
            context.lineWidth = 1
            for (let i = 1; i < timeDivisor; i++) {
                const minorPosY = (time + i / timeDivisor - beats) * timeRatio - yZero;
                drawLine(context, innerWidth / 2, -minorPosY, -innerWidth / 2, -minorPosY)
            }
            context.restore()
        }
        context.restore()
        context.lineWidth = 3;
        drawLine(context, innerWidth / 2, yZero, -innerWidth / 2, yZero)
        context.strokeStyle = "#EEE";
    }
    draw(beats?: number) {
        if (!this.target) {
            const context = this.context
            context.save();
            const clippingRect = this.clippingRect;
            context.clearRect(-clippingRect[2] / 2, -clippingRect[3] / 2, clippingRect[2], clippingRect[3]);
            context.fillStyle = "#EEE";
            context.textAlign = "center"
            context.fillText(
                this.type !== EventType.easing
                ? messages.NO_TARGET(
                    this.parentEditorSet.selectedLayer,
                    EventType[this.type]
                )
                : messages.NO_TARGET_EASING(), 0, 0)
            context.restore();
            return;
        }
        beats = beats || this.lastBeats || 0;
        this.updateMatrix()
        const {
            context,
            selectionManager
        }= this
        selectionManager.refresh()
        this.drawCoordination(beats)
        const startBeats = beats - this.timeSpan * (0.5 + this.timeBasis);
        const endBeats = beats + this.timeSpan * (0.5 + this.timeBasis);
        // 该数组用于自动调整网格
        // const valueArray = [];


        const line = this.targetLine;
        let len: number;
        if (
            line &&
            [
                EventType.moveX, EventType.moveY, EventType.alpha, EventType.rotate, EventType.speed,
                EventType.scaleX, EventType.scaleY, EventType.color
            ].includes(this.type)
            && !line.group.isDefault()
        ) {
            const group = line.group;
            const parent = this.parentEditorSet
            context.save();
            context.font = "25px Phigros"
            len = group.judgeLines.length;
            for (let i = 0; i < len; i++) {
                const judgeLine = group.judgeLines[i]!;
                if (judgeLine === line) { // 跳过本判定线，因为它在最后绘制
                    continue;
                }
                const sequence = this.type === EventType.speed ? judgeLine.speedSequence
                    : parent.selectedLayer === "ex" ? judgeLine.extendedLayer[EventType[this.type]]
                    : judgeLine.eventLayers[parent.selectedLayer][EventType[this.type]];
                if (!sequence) {
                    continue;
                }
                context.strokeStyle = context.fillStyle = `hsl(${i / len * 360}, 80%, 75%)`;
                context.globalAlpha = 1
                context.fillText(`${judgeLine.id}`, i * 14, 60);
                context.globalAlpha = 0.5;
                this.drawSequence(sequence, beats, startBeats, endBeats, i, len);
            }
            context.restore();
        }

        // 抬高真正的目标序列之优先级
        selectionManager.setBasePriority(1);
        this.drawSequence(this.target, beats, startBeats, endBeats, len ?? 0, len ?? 1);
        selectionManager.setBasePriority(0);


        
        if (this.state === EventCurveEditorState.selectingScope) {
            const {startingCanvasPoint, canvasPoint} = this;
            context.save()
            context.lineWidth = 3;
            context.strokeStyle = this.scopingColor;
            context.strokeRect(startingCanvasPoint.x, startingCanvasPoint.y, canvasPoint.x - startingCanvasPoint.x, canvasPoint.y - startingCanvasPoint.y);
            context.restore()
        }
        this.lastBeats = beats;
    }
    drawSequence(
        sequence: EventNodeSequence<VT>, beats: number,
        startBeats: number, endBeats: number,
        index: number, total: number
    ): void
    {
        const {selectionManager, context} = this;
        const NODE_HEIGHT = this.nodeHeight;
        const NODE_WIDTH = this.nodeWidth;
        const START_NODE_IMG = Images.START_NODE;
        const END_NODE_IMG = Images.END_NODE;
        
        let previousEndNode: EventEndNode<VT> | EventNodeLike<NodeType.HEAD, VT> = sequence.getNodeAt(startBeats < 0 ? 0 : startBeats).previous || sequence.head; // 有点奇怪的操作

        const yZero = this.innerHeight * this.timeBasis;

        // 我很少用do while循环。这里确实不需要检查第一次，肯定至少画出一根
        do {
            const startNode = previousEndNode.next;
            const endNode = startNode.next;
            if (endNode.type === NodeType.TAIL) {
                break;
            }
            const startXY = this.calculatePos(beats, startNode, index, total);
            const endXY = this.calculatePos(beats, endNode, index, total);
            const [startX, startY] = startXY;
            const [endX, endY] = endXY;
            const topY = startY;
            const topEndY = endY;
            const leftX = startX - NODE_WIDTH / 2; 
            const leftEndX = endX - NODE_WIDTH / 2;

            selectionManager.add({
                target: startNode,
                left: leftX,
                top: topY - NODE_HEIGHT,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                priority: 1
            })
            selectionManager.add({
                target: endNode,
                left: leftEndX,
                top: topEndY,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                priority: 1
            })

            const selected = this.nodesSelection.has(startNode)

            if (selected) {
                context.save()
                context.strokeStyle = 'cyan';
            }


            this.strokeCurve(context, startNode as NonLastStartNode<VT>, endNode, startXY, endXY, beats)
            if (selected) {
                context.restore()
            }
            context.drawImage(START_NODE_IMG, leftX, topY - NODE_HEIGHT, NODE_WIDTH, NODE_HEIGHT)
            context.drawImage(END_NODE_IMG, leftEndX, topEndY, NODE_WIDTH, NODE_HEIGHT)
            // console.log(this.type, EventType.speed)
            if (this.type === EventType.speed) {
                // console.log(startNode)
                // console.log(startNode.easing)
                context.lineWidth = 1;
                context.fillText(startNode.floorPosition.toFixed(4), startX, 0)
                context.lineWidth = 3
            }
            previousEndNode = endNode;

        } while (TC.toBeats((previousEndNode as EventEndNode<VT>).time) < endBeats)
        if (previousEndNode.next.next.type === NodeType.TAIL) {
            const lastStart = previousEndNode.next;
            const startXY = this.calculatePos(beats, lastStart, index, total);
            const [startX, startY] = startXY;
            const topY = startY - NODE_HEIGHT;
            const selected = this.nodesSelection.has(lastStart)
            if (selected) {
                context.save()
                context.strokeStyle = 'cyan';
            }
            this.strokeLastLineSegment(context, lastStart, startXY);
            if (selected) {
                context.restore()
            }
            context.drawImage(START_NODE_IMG, startX - NODE_WIDTH / 2, startY - NODE_HEIGHT, NODE_WIDTH, NODE_HEIGHT)
            selectionManager.add({
                target: lastStart,
                left: startX - NODE_WIDTH / 2,
                top: topY,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                priority: 1
            })

        }
    }

    /**
     * 
     * @param beats 
     * @param node 
     * @param seqIndex
     * @returns 节点参考点的虚拟坐标 
     */
    abstract calculatePos(beats: number, node: EventStartNode<VT> | EventEndNode<VT>, seqIndex: number, total: number): [number, number];
    abstract strokeCurve(
        context: CanvasRenderingContext2D,
        startNode: NonLastStartNode<VT>,
        endNode: EventEndNode<VT>, 
        startXY: [number, number],
        endXY: [number, number],
        beats: number
    ): void;
    abstract strokeLastLineSegment(
        context: CanvasRenderingContext2D,
        startNode: EventStartNode<VT>,
        startXY: [number, number],
    ): void;

    paste() {
        if (!this.active) {
            return;
        }
        const {lastBeats} = this;
        const clipboard = this.clipboard;
        const timeDivisor = this.parentEditorSet.timeDivisor;
        if (!clipboard || clipboard.size === 0) {
            return;
        }
        for (let ele of clipboard) {
            if (typeof ele.value === "number") {
                break;
            } else {
                return;
            }
        }
        if (!lastBeats) {
            this.notify("Have not rendered a frame")
        }
        const dest: TimeT = this.pointedTime

        
        const [_, newNodes] = EventNode.setToNewOrderedArray(dest, clipboard);
        this.operationList.do(new O.MultiNodeAddOperation(newNodes, this.target));
        
        this.nodesSelection = new Set<EventStartNode<VT>>(newNodes);
        this.dispatchEvent(new KPANodeScopeselectedEvent(this.nodesSelection));


    }
    copy(): void {
        if (!this.active) {
            return;
        }
        this.clipboard = this.nodesSelection;
        this.nodesSelection = new Set<EventStartNode<VT>>();
    }

    /**
     * 
     * @param this bpm和easing不允许创建
     */
    createTarget(this: VT extends (EventType.bpm | EventType.easing) ? never : EventSequenceEditor<VT>) {
        const line = this.targetLine;
        if (this.type === EventType.speed) {
            const seq = this.operationList.chart.createEventNodeSequence(this.type, `#${line.id}.speed`);
            this.targetLine.speedSequence = seq as SpeedENS;
            // @ts-expect-error
            this.target = seq;
        } else if (this.type < EventType.speed) { // 前四个种类（如果枚举顺序变了可能出问题，但肯定不会变的（
            if (this.parentEditorSet.selectedLayer === "ex") {
                return;
            }
            const seq = this.operationList.chart.createEventNodeSequence(this.type, `#${line.id}.${this.parentEditorSet.selectedLayer}.${EventType[this.type]}`);
            // @ts-expect-error
            this.operationList.do(new O.JudgeLineENSChangeOperation(line, parseInt(this.parentEditorSet.selectedLayer), EventType[this.type], seq))
            // @ts-expect-error
            this.target = seq;
        } else {
            if (this.parentEditorSet.selectedLayer !== "ex") {
                return;
            }
            const seq = this.operationList.chart.createEventNodeSequence(this.type, `#${line.id}.ex.${EventType[this.type]}`);
            // @ts-expect-error
            this.operationList.do(new O.JudgeLineExtendENSChangeOperation(line, EventType[this.type], seq as EventNodeSequence<string>))
            // @ts-expect-error
            this.target = seq;
        }
    
    }

    protected notify(message: string) {
        this.parentEditorSet.notify(message);
    }
    // begin 以下朝生夕死，不配置不可读的状态。如果你觉得哪个应该是可读的，请提issue拷打杨哲思
    protected selectionManager: SelectionManager<EventStartNode<VT> | EventEndNode<VT>>;
    protected startingPoint: Coordinate;
    protected startingCanvasPoint: Coordinate;
    protected canvasPoint: Coordinate;
    protected wasEditing: boolean;
    // private pointedValue: number; 这个不能用，在子类里面才声明它


    /** 从f64（TC.toBeats(time)）到TimeT的映射 ECE暂时没这东西，NE才有
    private timeMap: Map<number, TimeT> = new Map();*/
    protected pointedTime: TimeT;
    protected drawn: boolean;

    

    protected canvasMatrix: Matrix33;
    protected canvasMatrixInverted: Matrix33;
    // end 朝生夕死

    // begin 这些也是内部使用，但是活得久（可能）
    /** 上次渲染时的拍数 */
    public lastBeats: number;
    protected mouseIn: boolean;


    /** 画布坐标系到元素坐标系的映射，大小改变自动更新 */
    protected elementMatrix: Matrix33;
    /** 元素坐标系到画布坐标系的映射，大小改变自动更新 */
    protected elementMatrixInverted: Matrix33;
    // end
}

export class NumericEventCurveEditor extends EventSequenceEditor<number> {
    override readonly valueType = EventValueType.numeric;

    public pointedValue: number;
    
    attachableValues: number[] = [];
    
    valueRatio: number;
    valueGridColor = "rgb(255, 170, 120)";
    valueRange: readonly [number, number];
    
    valueGridInterval: number | undefined;
    

    constructor(
        type: Exclude<EventType, EventType.text | EventType.color>,
        
        canvas: HTMLCanvasElement,
        clippingRect: LTWH,
        operationList: O.OperationList,
        parentEditorSet: EventSequenceEditors
    ) {
        super(type, canvas, clippingRect, operationList, parentEditorSet);
        
        const config = eventTypeMap[type]
        this.valueRange = config.valueRange;
        this.valueRatio = this.innerWidth / lengthOf(this.valueRange);
        this.attachableValues = generateAttachable([config.valueGridSpan, 0], this.valueRange);

        this.updateMatrix();

    }

    override updateMatrix(): void {
        super.updateMatrix();
        // 扩展：值维度
        this.valueRatio = this.innerWidth / lengthOf(this.valueRange);
        this.timeRatio = this.innerHeight / this.timeSpan;
        const {
            valueRange,
            timeRatio,
            valueRatio
        } = this;
        this.matrix = identity.scale(valueRatio, -timeRatio).translate(-medianOf(valueRange), -this.timeSpan * this.timeBasis);
        this.matrixInverted = this.matrix.invert();
    }
    override drawCoordination(beats: number): void {
        super.drawCoordination(beats);
        // 扩展：吸附线
        const { context, attachableValues } = this;
        context.save()
        context.fillStyle = "#EEE";
        context.font = "16px phigros"
        
        context.textAlign = "center";
        context.strokeStyle = this.valueGridColor;
        context.lineWidth = 1;
        const height = this.clippingRect[3];
        const top = -height / 2;
        const bottom = height / 2;
        const textPosY = top + this.padding;
        context.fillStyle = this.valueGridColor;

        const len = attachableValues.length;
        const useDifferentPos = len > 12;
        const median = medianOf(this.valueRange);
        for (let i = 0; i < len; i++) {
            const value = attachableValues[i];
            const positionX = this.matrix.xmul(value, 0);
            drawLine(context, positionX, top, positionX, bottom);
            const posY = useDifferentPos && i % 2 == 1 ? textPosY + 16 : textPosY;
            context.fillText(value + "", positionX, posY);
        }
        context.restore();
    }

    
    moveHandler(event: MouseEvent | TouchEvent) { 
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        
        const parentEditorSet = this.parentEditorSet;
        const timeDivisor = parentEditorSet.timeDivisor;

        const {x: value, y: beats} = canvasCoord.mul(this.matrixInverted);
        this.pointedValue = computeAttach(this.attachableValues, value);

        const accurateBeats = beats + this.lastBeats
        let pointedBeats = Math.floor(accurateBeats)
        let beatFraction = Math.round((accurateBeats - pointedBeats) * timeDivisor)
        if (beatFraction === timeDivisor) {
            pointedBeats += 1
            beatFraction = 0
        }
        this.pointedTime = [pointedBeats, beatFraction, timeDivisor];

        switch (this.state) {
            case EventCurveEditorState.selecting:
                // console.log("det")
                this.operationList.do(new O.EventNodeValueChangeOperation(this.selectedNode, this.pointedValue))
                this.operationList.do(new O.EventNodeTimeChangeOperation(this.selectedNode, this.pointedTime))

        }
    }
    downHandler(event: MouseEvent | TouchEvent) {
        // 所有的数值性事件，包括X/Y缩放，都一定存在
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        
        const coord = canvasCoord.mul(this.matrixInverted);
        this.canvasPoint = canvasCoord;
        // console.log("ECECoord:" , [x, y])
        switch (this.state) {
            case EventCurveEditorState.select:
            case EventCurveEditorState.selecting:
                const snode = this.selectionManager.click(canvasCoord)
                this.state = !snode ? EventCurveEditorState.select : EventCurveEditorState.selecting;
                if (snode) {
                    this.selectedNode = snode.target
                    this.dispatchEvent(new KPANodeSelectedEvent(this.selectedNode));
                }
                // console.log(EventCurveEditorState[this.state])
                this.wasEditing = false;
                break;
            case EventCurveEditorState.edit:
                this.placeNode(this.pointedValue);
                this.state = EventCurveEditorState.selecting;
                this.wasEditing = true;
                break;
            case EventCurveEditorState.selectScope:
                this.startingPoint = coord;
                this.startingCanvasPoint = canvasCoord;
                this.state = EventCurveEditorState.selectingScope;
                break;
        }
    }
    upHandler(event: MouseEvent | TouchEvent) {
        
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        switch (this.state) {
            case EventCurveEditorState.selecting:
                if (!this.wasEditing) {
                    this.state = EventCurveEditorState.select;
                } else {
                    this.state = EventCurveEditorState.edit;
                }
                break;
            case EventCurveEditorState.selectingScope:
                const [sx, ex] = [this.startingCanvasPoint.x, canvasCoord.x].sort((a, b) => a - b);
                const [sy, ey] = [this.startingCanvasPoint.y, canvasCoord.y].sort((a, b) => a - b);
                const array = this.selectionManager.selectScope(sy, sx, ey, ex);
                // console.log("Arr", array);
                // console.log(sx, sy, ex, ey)
                const nodes = array.map(x => x.target).filter(x => x instanceof EventStartNode);
                // console.log(nodes);
                switch (this.selectState) {
                    case SelectState.extend:
                        this.nodesSelection = this.nodesSelection.union(new Set(nodes));
                        break;
                    case SelectState.replace:
                        this.nodesSelection = new Set(nodes);
                        break;
                    case SelectState.exclude:
                        this.nodesSelection = this.nodesSelection.difference(new Set(nodes));
                        break;
                }
                this.nodesSelection = new Set([...this.nodesSelection].filter((note: EventStartNode<any>) => !!note.parentSeq))
                // console.log("bp")
                if (this.nodesSelection.size !== 0) {
                    this.dispatchEvent(new KPANodeScopeselectedEvent(this.nodesSelection));
                }
                this.state = EventCurveEditorState.selectScope;
                break;
            default:
                this.state = EventCurveEditorState.select;
        }
    }
    calculatePos(beats: number, node: EventStartNode<number> | EventEndNode<number>, seqIndex: number): [number, number] {
        const pos = new Coordinate(node.value, TC.toBeats(node.time) - beats).mul(this.matrix);
        this.valuesInFrame.push(node.value);
        return [pos.x, pos.y];
    }
    /**
     * 
     * @param context 
     * @param startNode 
     * @param endNode 
     * @param startXY Canvas坐标
     * @param endXY Canvas坐标
     * @returns 
     */
    strokeCurve(context: CanvasRenderingContext2D, startNode: NonLastStartNode<number>, endNode: EventEndNode<number>, startXY: [number, number], endXY: [number, number], beats: number): void {
        const evaluator = startNode.evaluator;
        if (evaluator instanceof EasedEvaluator) {
            const easing = evaluator.easing;
            if (easing instanceof NormalEasing) {
                if (easing === linearEasing) {
                    // 这个横竖都一样
                    drawLine(context, startXY[0], startXY[1], endXY[0], endXY[1]);
                    return;
                } else if (easing === fixedEasing) {
                    // 这里的话，如果要用回KPA1的横版，可能需要修改代码
                    this.strokeForFixedEasing(context, startXY, endXY);
                    return;
                }
            } else if (easing instanceof BezierEasing) {
                drawBezierCurve(
                    context,
                    startXY,
                    endXY,
                    [easing.cp1[1], easing.cp1[0]],
                    [easing.cp2[1], easing.cp2[0]]
                );
                return;
            }
        }
        // 以上选项都不行的话只能插值了
        this.strokeGeneralCurve(
            context,
            startNode, endNode,
            startXY, endXY,
            beats
        )
    }
    strokeForFixedEasing(
        context: CanvasRenderingContext2D,
        startXY: [number, number],
        endXY: [number, number]
    ): void 
    {
        drawLine(context, startXY[0], startXY[1], startXY[0], endXY[1]);
    }
    strokeGeneralCurve(
        context: CanvasRenderingContext2D,
        startNode: EventStartNode<number>,
        endNode: EventEndNode<number>,
        startXY: [number, number],
        endXY: [number, number],
        beats: number
    ): void
    {
        const INTERPOLATION_STEP = 0.0125;
        const startBeats = TC.toBeats(startNode.time);
        const endBeats = TC.toBeats(endNode.time);
        const [startX, startY] = startXY;
        const [endX, endY] = endXY;
        /** endXY之前的点的个数 */
        const pointCount = Math.ceil((endBeats - startBeats) / INTERPOLATION_STEP);
        context.beginPath();
        context.moveTo(startX, startY);
        for (let i = 1; i < pointCount; i++) {
            const curBeats = startBeats + i * INTERPOLATION_STEP;
            const {x, y} = new Coordinate(
                startNode.getValueAt(curBeats),
                curBeats - beats
            ).mul(this.matrix);
            context.lineTo(x, y);
        }
        context.lineTo(endX, endY);
        context.stroke();
    }
    override strokeLastLineSegment(context: CanvasRenderingContext2D, startNode: EventStartNode<number>, startXY: [number, number]): void {
        drawLine(context, startXY[0], startXY[1], startXY[0], -this.canvas.height);
    }
    override draw(beats?: number): void {
        this.valuesInFrame = []; // 重置
        if (this.valueGridInterval) {
            this.attachableValues = generateAttachable([this.valueGridInterval, 0], this.valueRange);
        }
        super.draw(beats);
        this.adjust(this.valuesInFrame);
    }


    adjust(values: number[]): void {
        if (this.state !== EventCurveEditorState.select) {
            return;
        }
        const valueRange = this.valueRange;
        const distinctValueCount = new Set(values).size;
        if (distinctValueCount < 2 && valueRange[0] < values[0] && values[0] < valueRange[1]) {
            return;
        }
        if (this.autoRangeEnabled) {
            
            const sorted = values.sort((a, b) => a - b);
            const lengthOfValue = lengthOf(valueRange);
            // 如果上四分位数超出了valueRange，则扩大valueRange右边界valueRange长度的一半。
            // 如果上四分位数不及valueRange的2/3处位置，则缩小valueRange右边界valueRange长度的一半。
            // 下四分位数同理
            const upper = getPercentile(sorted, 0.95);
            const lower = getPercentile(sorted, 0.05);
            const pos1Third = percentileOf(valueRange, 0.34);
            const pos2Third = percentileOf(valueRange, 0.66);
            const range: [number, number] = [...this.valueRange];
            if (upper > valueRange[1]) {
                range[1] = valueRange[1] + lengthOfValue / 2;
            } else if (upper < pos2Third) {
                range[1] = valueRange[1] - lengthOfValue / 3;
            }
            if (lower < valueRange[0]) {
                range[0] = valueRange[0] - lengthOfValue / 2;
            } else if (lower > pos1Third) {
                range[0] = valueRange[0] + lengthOfValue / 3;
            }
            this.valueRange = range;
        }

        // 计算合适的valueGridSpan
        // 根据这个值能够整除多少个值。
        
        let valueGridSpan = eventTypeMap[this.type]!.valueGridSpan;
        if (this.valueGridInterval) {
            valueGridSpan = this.valueGridInterval;
        } else {
            let priority = 0;
            const len = values.length;
            for (let i = 0; i < len; i++) {
                const v = values[i];
                if (v === 0) {
                    continue;
                }
                const p = values.reduce((acc, cur) => {
                    return cur % v === 0 ? acc + 1 : acc
                });
                if (p > priority * 1.2) {
                    priority = p;
                    valueGridSpan = v;
                }
            }
            valueGridSpan = divideOrMul(valueGridSpan, 10 / (lengthOf(this.valueRange) / valueGridSpan));
        }
        if (distinctValueCount > 10) {
            this.attachableValues = generateAttachable([valueGridSpan, 0], this.valueRange);
        } else {
                
            this.attachableValues = Array.from(new Set([...generateAttachable([valueGridSpan, 0], this.valueRange), ...values])).sort((a, b) => a - b);
        }
        
    }


    protected valuesInFrame: number[];

    /** [value, time] -> [x, y] */
    protected matrix: Matrix33;
    /** [x, y] -> [value, time] */
    protected matrixInverted: Matrix33;
}

export class TextEventSequenceEditor extends EventSequenceEditor<string> {
    override readonly valueType = EventValueType.text;
    constructor(type: EventType.text, canvas: HTMLCanvasElement, clippingRect: LTWH, operationList: O.OperationList, parentEditorSet: EventSequenceEditors) {
        super(type, canvas, clippingRect, operationList, parentEditorSet);
        this.updateMatrix();
    }
    override moveHandler(event: MouseEvent | TouchEvent): void {
        const coord =
        this.canvasPoint = getCanvasCoordFromEvent(event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
                
        const timeDivisor = this.parentEditorSet.timeDivisor;
        
        const offsetBeats = (this.innerHeight * this.timeBasis - coord.y) / (this.timeGridInterval * this.timeRatio); // 颜色事件编辑器没有第三层矩阵，因为没有值维度

        const accurateBeats = offsetBeats + this.lastBeats;
        let pointedBeats = Math.floor(accurateBeats)
        let beatFraction = Math.round((accurateBeats - pointedBeats) * timeDivisor)
        if (beatFraction === timeDivisor) {
            pointedBeats += 1
            beatFraction = 0
        }
        this.pointedTime = [pointedBeats, beatFraction, this.parentEditorSet.timeDivisor];

        switch (this.state) {
            case EventCurveEditorState.selecting:
                // console.log("det")
                this.operationList.do(new O.EventNodeTimeChangeOperation(this.selectedNode, this.pointedTime))

        }
    }
    
    downHandler(event: MouseEvent | TouchEvent) {
        if (!this.target) {
            this.createTarget();
            return;
        }
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        // console.log("ECECoord:" , [x, y])
        switch (this.state) {
            case EventCurveEditorState.select:
            case EventCurveEditorState.selecting:
                const snode = this.selectionManager.click(canvasCoord)
                this.state = !snode ? EventCurveEditorState.select : EventCurveEditorState.selecting;
                if (snode) {
                    this.selectedNode = snode.target
                    this.dispatchEvent(new KPANodeSelectedEvent(this.selectedNode));
                }
                // console.log(EventCurveEditorState[this.state])
                this.wasEditing = false;
                break;
            case EventCurveEditorState.edit:
                this.placeNode(null);
                this.state = EventCurveEditorState.selecting;
                this.wasEditing = true;
                break;
            case EventCurveEditorState.selectScope:
                this.startingCanvasPoint = canvasCoord;
                this.state = EventCurveEditorState.selectingScope;
                break;
        }
    }

    
    
    upHandler(event: MouseEvent | TouchEvent) {
        // 这个方法和上面那个数值事件编辑器其实是一样的
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        switch (this.state) {
            case EventCurveEditorState.selecting:
                if (!this.wasEditing) {
                    this.state = EventCurveEditorState.select;
                } else {
                    this.state = EventCurveEditorState.edit;
                }
                break;
            case EventCurveEditorState.selectingScope:
                const [sx, ex] = [this.startingCanvasPoint.x, canvasCoord.x].sort((a, b) => a - b);
                const [sy, ey] = [this.startingCanvasPoint.y, canvasCoord.y].sort((a, b) => a - b);
                const array = this.selectionManager.selectScope(sy, sx, ey, ex);
                // console.log("Arr", array);
                // console.log(sx, sy, ex, ey)
                const nodes = array.map(x => x.target).filter(x => x instanceof EventStartNode);
                // console.log(nodes);
                switch (this.selectState) {
                    case SelectState.extend:
                        this.nodesSelection = this.nodesSelection.union(new Set(nodes));
                        break;
                    case SelectState.replace:
                        this.nodesSelection = new Set(nodes);
                        break;
                    case SelectState.exclude:
                        this.nodesSelection = this.nodesSelection.difference(new Set(nodes));
                        break;
                }
                this.nodesSelection = new Set([...this.nodesSelection].filter((note: EventStartNode<any>) => !!note.parentSeq))
                // console.log("bp")
                if (this.nodesSelection.size !== 0) {
                    this.dispatchEvent(new KPANodeScopeselectedEvent(this.nodesSelection));
                }
                this.state = EventCurveEditorState.selectScope;
                break;
            default:
                this.state = EventCurveEditorState.select;
        }
    }

    override calculatePos(beats: number, node: EventStartNode<string> | EventEndNode<string>, seqIndex: number, total: number): [number, number] {
        const x = ((seqIndex + 0.5) / total - 0.5) * this.innerWidth;
        return [x, -(TC.toBeats(node.time) - beats) * this.timeRatio + this.innerHeight * this.timeBasis];
    }

    override strokeCurve(context: CanvasRenderingContext2D, startNode: NonLastStartNode<string>, endNode: EventEndNode<string>, startXY: [number, number], endXY: [number, number], beats: number): void {
        drawLine(context, startXY[0], startXY[1], endXY[0], endXY[1]);
        context.fillText(startNode.value, startXY[0], startXY[1]);
    }

    override strokeLastLineSegment(context: CanvasRenderingContext2D, startNode: EventStartNode<string>, startXY: [number, number]): void {
        drawLine(context, startXY[0], startXY[1], startXY[0], -this.clippingRect[3] / 2);
        context.fillText(startNode.value, startXY[0], startXY[1]);
    }
}

export class ColorEventSequenceEditor extends EventSequenceEditor<RGB> {
    override readonly valueType = EventValueType.color;
    constructor(type: EventType.color, canvas: HTMLCanvasElement, clippingRect: LTWH, operationList: O.OperationList, parentEditorSet: EventSequenceEditors) {
        super(type, canvas, clippingRect, operationList, parentEditorSet);
        this.updateMatrix();
    }
    override moveHandler(event: MouseEvent | TouchEvent): void {
        const coord =
        this.canvasPoint = getCanvasCoordFromEvent(event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
                
        const timeDivisor = this.parentEditorSet.timeDivisor;
        
        const offsetBeats = (this.timeBasis * this.innerHeight - coord.y) / (this.timeGridInterval * this.timeRatio); // 文本事件编辑器没有第三层矩阵，因为没有值维度

        const accurateBeats = offsetBeats + this.lastBeats;
        let pointedBeats = Math.floor(accurateBeats)
        let beatFraction = Math.round((accurateBeats - pointedBeats) * timeDivisor)
        if (beatFraction === timeDivisor) {
            pointedBeats += 1
            beatFraction = 0
        }
        this.pointedTime = [pointedBeats, beatFraction, this.parentEditorSet.timeDivisor];

        switch (this.state) {
            case EventCurveEditorState.selecting:
                // console.log("det")
                this.operationList.do(new O.EventNodeTimeChangeOperation(this.selectedNode, this.pointedTime))

        }
    }
    
    downHandler(event: MouseEvent | TouchEvent) {
        if (!this.target) {
            this.createTarget();
            return;
        }
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        // console.log("ECECoord:" , [x, y])
        switch (this.state) {
            case EventCurveEditorState.select:
            case EventCurveEditorState.selecting:
                const snode = this.selectionManager.click(canvasCoord)
                this.state = !snode ? EventCurveEditorState.select : EventCurveEditorState.selecting;
                if (snode) {
                    this.selectedNode = snode.target
                    this.dispatchEvent(new KPANodeSelectedEvent(this.selectedNode));
                }
                // console.log(EventCurveEditorState[this.state])
                this.wasEditing = false;
                break;
            case EventCurveEditorState.edit:
                this.placeNode(null);
                this.state = EventCurveEditorState.selecting;
                this.wasEditing = true;
                break;
            case EventCurveEditorState.selectScope:
                this.startingCanvasPoint = canvasCoord;
                this.state = EventCurveEditorState.selectingScope;
                break;
        }
    }

    
    
    upHandler(event: MouseEvent | TouchEvent) {
        // 这个方法和上面那个数值事件编辑器其实是一样的
        const canvasCoord =
        this.canvasPoint = getCanvasCoordFromEvent(
            event, this.canvas,
            this.elementMatrixInverted,
            this.canvasMatrixInverted
        );
        switch (this.state) {
            case EventCurveEditorState.selecting:
                if (!this.wasEditing) {
                    this.state = EventCurveEditorState.select;
                } else {
                    this.state = EventCurveEditorState.edit;
                }
                break;
            case EventCurveEditorState.selectingScope:
                const [sx, ex] = [this.startingCanvasPoint.x, canvasCoord.x].sort((a, b) => a - b);
                const [sy, ey] = [this.startingCanvasPoint.y, canvasCoord.y].sort((a, b) => a - b);
                const array = this.selectionManager.selectScope(sy, sx, ey, ex);
                // console.log("Arr", array);
                // console.log(sx, sy, ex, ey)
                const nodes = array.map(x => x.target).filter(x => x instanceof EventStartNode);
                // console.log(nodes);
                switch (this.selectState) {
                    case SelectState.extend:
                        this.nodesSelection = this.nodesSelection.union(new Set(nodes));
                        break;
                    case SelectState.replace:
                        this.nodesSelection = new Set(nodes);
                        break;
                    case SelectState.exclude:
                        this.nodesSelection = this.nodesSelection.difference(new Set(nodes));
                        break;
                }
                this.nodesSelection = new Set([...this.nodesSelection].filter((note: EventStartNode<any>) => !!note.parentSeq))
                // console.log("bp")
                if (this.nodesSelection.size !== 0) {
                    this.dispatchEvent(new KPANodeScopeselectedEvent(this.nodesSelection));
                }
                this.state = EventCurveEditorState.selectScope;
                break;
            default:
                this.state = EventCurveEditorState.select;
        }
    }

    override calculatePos(beats: number, node: EventStartNode<RGB> | EventEndNode<RGB>, seqIndex: number, total: number): [number, number] {
        const x = ((seqIndex + 0.5) / total - 0.5) * this.innerWidth;
        return [x, -(TC.toBeats(node.time) - beats) * this.timeRatio + this.innerHeight * this.timeBasis];
    }

    override strokeCurve(context: CanvasRenderingContext2D, startNode: NonLastStartNode<RGB>, endNode: EventEndNode<RGB>, startXY: [number, number], endXY: [number, number], beats: number): void {
        if (this.nodesSelection.has(startNode)) {
            // 在外面已经设定了strokeStyle，因此这里不需要
            drawLine(context, startXY[0], startXY[1], endXY[0], endXY[1]);
            return;
        }
        const gradient = context.createLinearGradient(startXY[0], startXY[1], endXY[0], endXY[1]);
        const startValue = startNode.value;
        const endValue = endNode.value;
        
        gradient.addColorStop(0, rgb(...startValue));
        gradient.addColorStop(1, rgb(...endValue));
        const evaluator = startNode.evaluator
        if (!(evaluator instanceof EasedEvaluator) || evaluator.easing !== linearEasing) {
            for (let i = 1; i < COLOR_INTERPOLATION_MAX_STOPS; i++) {
                const pos = COLOR_INTERPOLATION_STEP * i;
                const val: RGB = 
                    evaluator instanceof ColorEasedEvaluator
                        ? evaluator.convert(startValue, endValue, pos)
                    : evaluator instanceof ExpressionEvaluator
                        ? evaluator.func(pos)
                    : evaluator instanceof MacroEvaluator
                        ? evaluator.consumers.get(startNode)?.func(pos)
                    : evaluator.eval(startNode, TC.toBeats(startNode.time) + pos * (TC.toBeats(endNode.time) - TC.toBeats(startNode.time)));
                    // UNREACHABLE, theoretically
                gradient.addColorStop(pos, rgb(...val));
            }
        }
        context.strokeStyle = gradient;
        drawLine(context, startXY[0], startXY[1], endXY[0], endXY[1]);
    }

    override strokeLastLineSegment(context: CanvasRenderingContext2D, startNode: EventStartNode<RGB>, startXY: [number, number]): void {
        context.strokeStyle = rgb(...startNode.value);
        drawLine(context, startXY[0], startXY[1], startXY[0], -this.clippingRect[3] / 2);
    }
}
