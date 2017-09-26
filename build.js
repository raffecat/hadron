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

  string(binding) {
    // expression text for a string-typed argument.
    const ref = binding.resolve();
    if (ref.is === 'literal') {
      return JSON.stringify(ref.value);
    } else if (ref.is === 'slot') {
      return ref.slot;
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
  resolve() {
    return this; // end-point of the resolve process.
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
  resolve() {
    return this; // end-point of the resolve process.
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
  constructor(name, type, inst, tpl) {
    const ref = inst.args[name] || error("missing field '"+name+"' in "+inst.path());
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
  // an instance of a template.

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
    // create a Binding to represent this specific expansion of an argument binding.
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
      if (!got.resolve) {
        error(`object from field '${field}' is not resolvable in ${inst.path()}`, got);
      }
      inst = got.resolve();
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
        const ref = dep.resolve();
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

  output(name, type) {
    const slot = this.tpl.uid(name);
    const dep = new ValueSlot(name, type, slot, this);
    this.fields.set(name, dep);
    return dep;
  }

  input(name, type) {
    // queue a binding in the template for resolving later.
    return this.tpl.bind_to(name, type, this);
  }

  action(deps, emit) {
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
