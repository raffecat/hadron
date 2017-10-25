#!/usr/bin/env node
"use strict";

// Core ideas:
// Component composition as the core abstraction.
// Dependency-tracked properties with re-computed expressions.

const fs = require('fs');
const components = require('./components');

const log = console.log;
const hasOwn = Object.prototype.hasOwnProperty;

const libs = {
  fs: 'fs'
};

function error(msg, obj) {
  console.log("error: "+msg, obj);
  process.exit(1);
}

class EmitContext {
  // a temporary object used to track action-context while emitting code.

  constructor(tpl, inst, prefix, captureMap) {
    this.tpl = tpl;
    this.inst = inst;
    this.lines = tpl.lines;
    this.prefix = prefix;
    this.captureMap = captureMap;
  }

  string(binding) {
    // expression text for a string-typed argument.
    const ref = binding.resolve();
    if (ref.is === 'literal') {
      return JSON.stringify(ref.value);
    } else if (ref.is === 'slot') {
      const slot = ref.slot;
      const captures = this.captureMap;
      if (captures) {
        const rename = captures.get(slot);
        if (rename) return rename;
      }
      return slot;
    } else {
      error("inappropriate end-point for es.string(): "+ref.is);
    }
  }

  emit(code) {
    this.lines.push(this.prefix+code);
  }

  emit_triggered(ref, indent) {
    if (ref.is !== 'slot') error("emit_triggered requires a local slot", ref);
    if (ref.mode !== 'const') {
      const prefix = this.prefix+indent;
      for (let act of ref.queued) {
        const es = new EmitContext(this.tpl, act.inst, prefix);
        act.emit(es);
      }
    } else {
      error("bad 'mode' for es.emit_triggered(): "+ref.is);
    }
  }

};

class Reference {
  // a named reference produced by the parser.
  // an unresolved reference to a parameter or output field (to resolve in each TemplateContext)
  constructor(name) {
    this.is = 'ref';
    this.mode = 'resolvable';
    this.name = name;
    this.path = name.split('.');
  }
  resolve(tpl) {
    // resolve the ref-path in the template-context that was passed in (typically via Binding)
    // do NOT cache the resolved value (a Reference is resolved again for each Binding)
    if (!tpl) error("reference ${this.name} cannot be resolved without a TemplateContext");
    return tpl.resolve_path(this.path);
  }
}

class ValueSlot {
  constructor(name, type, slot, inst) {
    this.is = 'slot';
    this.mode = 'once';
    this.type = type;
    this.slot = slot;
    this.queued = []; // actions that depend on this value-slot.
    this.field = name;
    this.inst = inst;
  }
  path() {
    return `value-slot ${this.field} in ${this.inst.path()}`;
  }
  resolve() {
    return this; // end-point of the resolve process.
  }
  isConst() {
    return false;
  }
  asBool() {
    if (this.type !== 'boolean') error("binding must be a boolean value: "+this.path());
    return this.slot;
  }
  whenTrue() {
    // emit all actions predicated on this value being true.
    return '';
  }
  whenFalse() {
    // emit all actions predicated on this value being false.
    return '';
  }
}

class Literal {
  // a literal value produced by the parser.
  constructor(type, value) {
    this.is = 'literal';
    this.mode = 'const';
    this.type = type;
    this.value = value;
  }
  path() {
    return `literal-${this.type}`;
  }
  resolve() {
    return this; // end-point of the resolve process.
  }
  isConst() {
    return true;
  }
  asBool() {
    if (this.type !== 'boolean') error("binding must be a boolean value: "+this.path());
    return this.value;
  }
}

class Action {
  constructor(deps, emit, inst) {
    this.is = 'action';
    this.wait = deps;
    this.emit = emit;
    this.inst = inst;
  }
}

class Binding {
  // created for every binding to a component input at a component use-site.
  // resolved in resolve_acts using resolve() --> ValueSlot | Literal.
  constructor(name, type, inst, tpl, defaultValue) {
    var ref = hasOwn.call(inst.args, name) ? inst.args[name] : null;
    if (ref == null) {
      if (defaultValue != null) {
        if (typeof(defaultValue)==='string') ref = new Literal('text', defaultValue);
        else ref = new Literal(typeof(defaultValue), defaultValue);
      } else {
        error("missing field '"+name+"' in "+inst.path());
      }
    }
    this.is = 'binding';
    this.to = ref;
    this.type = type;
    this.field = name;
    this.inst = inst;
    this.tpl = tpl;
    this.resolved = null;
  }
  resolve() {
    if (this.resolved != null) {
      return this.resolved; // already resolved.
    }
    const ref = this.to.resolve(this.tpl); // NB. pass in our template-context.
    if (ref.type !== this.type) {
      error(`type mismatch: field '${this.field}' must be '${this.type}' but found '${ref.type}' in ${this.inst.path()}`);
    }
    this.resolved = ref;
    return ref;
  }
};

class TemplateContext {
  // an instance of a template (component definition)

  constructor(name) {
    this.name = name;
    this.imports = new Map();
    this.uidMap = new Map();
    this.bound = new Map();
    this.lines = [];
    this.bindings = []; // not used.
    this.acts = [];
    this.roots = [];
  }

  uid(name) {
    // generate a unique symbol for the output code.
    const n = (this.uidMap.get(name) || 0) + 1;
    this.uidMap.set(name, n);
    return name+'_'+n;
  }

  bind_to(name, type, inst, defaultValue) {
    // create a Binding to represent this specific expansion of an argument binding.
    const dep = new Binding(name, type, inst, this, defaultValue);
    this.bindings.push(dep);
    return dep;
  }

  bind_inst(id, inst) {
    if (this.bound.get(id)) {
      error(`duplicate id '${id}' on instance ${inst.path()}`);
    }
    this.bound.set(id, inst);
  }

  resolve_path(path) {
    if (!path.length) return null;
    var inst = this.bound.get(path[0]);
    if (!inst) return null;
    for (let i=1; i<path.length; i++) {
      if (inst.is !== 'instance') {
        error(`object ${inst.path()} does not have fields in '${path.join('.')}'`);
      }
      let field = path[i];
      let got = inst.fields.get(field);
      if (!got) {
        error(`no such field '${field}' in instance ${inst.path()}`);
      }
      if (!got.resolve) {
        error(`object from field '${field}' is not resolvable in ${inst.path()}`, got);
      }
      inst = got.resolve();
    }
    return inst;
  }

  resolve_acts() {
    // resolve the dependencies of each action and queue the action.
    const tpl = this;
    for (let act of this.acts) {
      log("act: "+act.inst.where);
      const needs = [];
      for (let dep of act.wait) {
        // resolve the dependency.
        const ref = dep.resolve();
        // collect 'once' and 'multi' dependencies.
        if (ref.mode !== 'const') {
          needs.push(ref);
        }
      }
      act.needs = needs;
      if (needs.length === 0) {
        // queue this as a root action (all inputs are const)
        // TODO: might not require an action (evaluate at compile-time)
        this.roots.push(act);
      } else if (needs.length === 1) {
        // queue against the single dependency.
        log("queued action against: ", needs[0].field, needs[0].inst.path());
        needs[0].queued.push(act);
      } else {
        log("action has multiple dependencies: ", act);
        // generate a counter var and wrapper-function name.
        const counterVar = this.uid('counter');
        const actorVar = this.uid('actor');
        const captures = needs.map((ref) => tpl.uid(ref.slot));
        const captureMap = new Map();
        this.lines.push(`var ${counterVar} = ${needs.length}, ${captures.join(', ')};`);
        // queue a root action to emit the wrapper function, triggering this action.
        const actor = new Action([], function (es) {
          es.emit(`function ${actorVar}() {`);
          const es2 = new EmitContext(tpl, act.inst, '  ', captureMap);
          // FIXME: when this action is emitted, it must use the captures instead of
          // the original ValueSlot bindings, BUT the original ValueSlots are hidden
          // inside the action emit closures :(
          act.emit(es2);
          es.emit(`}`);
        }, act.inst);
        this.roots.push(actor);
        // iterate over the needs, queueing an action that decrements the counter.
        for (let nid=0; nid<needs.length; ++nid) {
          const need = needs[nid];
          captureMap.set(need.slot, captures[nid]);
          const decrAct = new Action([need], function (es) {
            es.emit(`${captures[nid]} = ${need.slot};`);
            es.emit(`if (!--${counterVar}) ${actorVar}();`);
          }, act.inst);
          need.queued.push(decrAct);
        }
      }
    }
  }

  emit_code() {
    const imports = this.imports, lines = this.lines;

    // emit the imports.
    for (let lib of imports.keys()) {
      const sym = imports.get(lib);
      const path = libs[lib];
      lines.push(`var ${sym} = require("${path}");`);
    }
    lines.push('');

    // emit all the root actions.
    for (let act of this.roots) {
      const es = new EmitContext(this, act.inst, '');
      act.emit(es);
    }
  }

  print() {
    console.log(this.lines.join("\n"));
  }

  write(name) {
    fs.writeFileSync(name, this.lines.join("\n")+"\n", 'utf8');
  }

}

class InstanceContext {
  // an API for built-in instance expansion (one per use-site)
  // used to parse argument bindings and generate actions as `cs`.

  constructor(tpl, args, where) {
    this.is = 'instance';
    this.fields = new Map();
    this.tpl = tpl;
    this.args = args;
    this.where = where;
    this.used = {};
  }

  path() {
    return this.where + ' in ' + this.tpl.name;
  }

  imports(name) {
    const tpl = this.tpl, imports = tpl.imports;
    const sym = imports.get(name);
    if (sym) return sym;
    if (!libs[name]) error("unknown import '"+name+"' in "+this.path());
    const uid = tpl.uid(name);
    imports.set(name, uid);
    return uid;
  }

  uid(name) {
    // unique name for a local function or private symbol.
    return this.tpl.uid(name);
  }

  slot(name, type) {
    // private state slot.
    const slot = this.tpl.uid(name);
    return new ValueSlot(name, type, slot, this);
  }

  output(name, type) {
    const slot = this.tpl.uid(name);
    const dep = new ValueSlot(name, type, slot, this);
    this.fields.set(name, dep);
    return dep;
  }

  input(name, type, defaultValue) {
    // queue a binding in the template for resolving later.
    return this.tpl.bind_to(name, type, this, defaultValue);
  }

  action(deps, emit) {
    // queue an action in the template for resolving later.
    log("action dep in "+this.where);
    const act = new Action(deps, emit, this);
    this.tpl.acts.push(act);
  }

  once(deps, emit) {
    // queue an action in the template for resolving later.
    log("action dep in "+this.where);
    const act = new Action(deps, emit, this);
    this.tpl.acts.push(act);
  }

};

function generate(ast) {
  // spawn an instance of the template (a TemplateContext)
  // within the template, spawn an instance of each component (an InstanceContext)
  const tpl = new TemplateContext('main');
  for (let item of ast) {
    const is = item.is, id = item.id, args = item.args;
    const defn = components[is] || error("missing defn for '"+is+"'");
    const cs = new InstanceContext(tpl, args, is+':'+id);
    tpl.bind_inst(id, cs);
    defn(cs);
  }
  tpl.resolve_acts();
  tpl.emit_code();
  tpl.write('out.js');
}

function text(str) { return new Literal('text', str); }
function ref(str) { return new Reference(str); }
function use(is, id, args) {
  return {
    is: is || error(`missing 'is'`, item),
    id: id || error(`missing 'id'`, item),
    args: args || error(`missing 'args'`, item)
  };
}

// change this to use explicit output to @name instead of binding to fields of instances?

const ast = [
  use('WriteText', 'wr', {
    filename: text('copy.json'),
    in: ref('cc2.out')
  }),
  use('EncodeJSON', 'je', {
    in: ref('jp.out')
  }),
  use('ParseJSON', 'jp', {
    in: ref('rd.out')
  }),
  use('ReadText', 'rd', {
    filename: text('../curseof/package.json')
  }),
  use('ReadText', 'rd2', {
    filename: text('../curseof/package.json')
  }),
  use('ConcatText', 'cc1', {
    left: ref('je.out'),
    right: text(' and DONE.')
  }),
  use('ConcatText', 'cc2', {
    left: ref('cc1.out'),
    right: ref('rd2.out')
  }),
  use('LogText', 'log1', {
    in: ref('cc2.out')
  }),


  /*
  use('WebGLCanvas', 'canvas', {
  }),
  use('LoadImage', 'lim', {
    src: text('assets/tiles.png')
  }),
  */
];

generate(ast);
