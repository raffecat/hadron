#!/usr/bin/env node
"use strict";

// Core ideas:
// Component composition as the core abstraction.
// Dependency-tracked properties with re-computed expressions.

const log = console.log;
const fs = require('fs');
const components = require('./components');

const libs = {
  fs: 'fs'
};

function error(msg, obj) {
  console.log("error: "+msg, obj);
  process.exit(1);
}

class EmitContext {
  // a temporary object used to track action-context while emitting code.

  constructor(tpl, inst, prefix) {
    this.tpl = tpl;
    this.inst = inst;
    this.lines = tpl.lines;
    this.prefix = prefix;
  }

  string(bound) {
    // expression text for a string-typed argument.
    const ref = bound.resolved || error("bound wasn't resolved", bound);
    if (ref.is === 'literal') {
      return JSON.stringify(ref.value);
    } else if (ref.is === 'slot') {
      return ref.slot;
    } else {
      error("bad 'is' for es.string(): "+ref.is);
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

function resolve(dep, in_tpl) {
  if (dep.is === 'bound') {
    // binding to a 'ref' or 'literal' or 'slot'.
    const ref = resolve(dep.to, dep.tpl);
    if (ref.type !== dep.type) {
      error(`type mismatch: field '${dep.field}' must be '${dep.type}' but found '${ref.type}' in ${dep.inst.path()}`);
    }
    dep.resolved = ref;
    return ref;
  } else if (dep.is === 'ref') {
    // resolve the ref-path in the tpl that was passed (i.e. via is='bound')
    return in_tpl.resolve_path(dep.path);
  } else if (dep.is === 'slot') {
    // slots don't need to be resolved.
    return dep;
  } else if (dep.is === 'literal') {
    // literals don't need to be resolved.
    return dep;
  } else {
    error("cannot resolve dep: unknown 'is' value: '"+dep.is+"'");
  }
}

class Binding {
  // created for every binding to a component input.
  // resolved in resolve_acts using resolve() --> Slot | Literal.
  constructor(name, type, inst, tpl) {
    const ref = inst.args[name] || error("missing field '"+name+"' in "+inst.path());
    this.is = 'bound';
    this.to = ref;
    this.type = type;
    this.field = name;
    this.inst = inst;
    this.tpl = tpl;
    this.resolved = null;
  }
};

class TemplateContext {
  // accumulates all actions and bound-names generated in a template.

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

  bind_to(name, type, inst) {
    const dep = new Binding(name, type, inst, this);
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
      inst = resolve(got, this);
    }
    return inst;
  }

  resolve_acts() {
    // resolve the dependencies of each action and queue the action.
    for (let act of this.acts) {
      log("act: "+act.inst.where);
      const needs = [];
      for (let dep of act.wait) {
        // resolve the dependency.
        const ref = resolve(dep, this);
        // collect 'once' and 'multi' dependencies.
        if (ref.mode !== 'const') {
          needs.push(ref);
        }
      }
      act.needs = needs;
      if (needs.length === 0) {
        // queue this as a root action (all inputs are const)
        this.roots.push(act);
      } else if (needs.length === 1) {
        // queue against the single dependency.
        log("queued action against: ", needs[0].field, needs[0].inst.path());
        needs[0].queued.push(act);
      } else {
        error("TODO: action has multiple dependencies: ", act);
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

  output(name, type) {
    const slot = this.tpl.uid(name);
    const dep = { is:'slot', type:type, mode:'once', queued:[], slot:slot, field:name, inst:this };
    this.fields.set(name, dep);
    return dep;
  }

  input(name, type) {
    // queue a binding in the template for resolving later.
    return this.tpl.bind_to(name, type, this);
  }

  text(name) {
    // queue a binding in the template for resolving later.
    return this.tpl.bind_to(name, 'text', this);
  }

  number(name) {
    // queue a binding in the template for resolving later.
    return this.tpl.bind_to(name, 'number', this);
  }

  action(deps, emit) {
    // queue an action in the template for resolving later.
    log("action dep in "+this.where);
    const act = { is:'action', wait:deps, emit:emit, inst:this };
    this.tpl.acts.push(act);
  }

};

function generate(ast) {
  const tpl = new TemplateContext('main');
  for (let item of ast) {
    const is = item.is, id = item.id, args = item.args;
    const defn = components[is] || error("missing defn for '"+is+"'");
    const cs = new InstanceContext(tpl, args, is+':'+id);
    tpl.bind_inst(id, cs);
    defn(cs);
  }
  // FIXME: at this point we can resolve all named bindings. even if we embed an instance
  // of a type-param component, we can (should) resolve the field-constraints on it here.
  tpl.resolve_acts();
  tpl.emit_code();
  tpl.write('out.js');
}

function text(str) { return { is:'literal', type:'text', mode:'const', value:str }; }
function ref(str) { return { is:'ref', path:str.split('.') }; }
function use(is, id, args) { return { is:is, id:id, args:args }; }

const ast = [
  use('WriteText', 'wr', {
    filename: text('copy.json'),
    in: ref('je.out')
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
];

generate(ast);
