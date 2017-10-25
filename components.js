"use strict";

module.exports = {
  ReadText,
  WriteText,
  LogText,
  ParseJSON,
  EncodeJSON,
  ConcatText,
  LoadImage,
  WebGLCanvas,
};

function ReadText(cs) {
  const fs = cs.imports('fs');
  const filename = cs.input('filename', 'text');
  const data = cs.output('out', 'text');
  cs.action([filename], function(es) {
    const name = es.string(filename);
    // the continuation needs to be a waitable node that other nodes can depend on.
    // if a node depends on two, decr its counter and call on zero [move dep to a fun]
    es.emit(`${fs}.readFile(${name}, 'utf8', function (err, ${data.slot}) {`);
    es.emit(`  if (err) throw err;`);
    es.emit_triggered(data, '  ');
    es.emit(`});`);
  });
}

function WriteText(cs) {
  const fs = cs.imports('fs');
  const filename = cs.input('filename', 'text');
  const data = cs.input('in', 'text');
  cs.action([filename, data], function(es) {
    const name = es.string(filename);
    const src = es.string(data);
    es.emit(`${fs}.writeFile(${name}, ${src}, 'utf8', function (err) {`);
    es.emit(`  if (err) throw err;`);
    es.emit(`});`);
  });
}

function ConcatText(cs) {
  const left = cs.input('left', 'text');
  const right = cs.input('right', 'text');
  const out = cs.output('out', 'text');
  cs.action([left, right], function(es) {
    const result = es.string(left) + es.string(right);
    es.emit(`const ${out.slot} = ${es.string(left)} + ${es.string(right)};`);
    es.emit_triggered(out, '');
  });
}

function LogText(cs) {
  const data = cs.input('in', 'text');
  cs.action([data], function(es) {
    const src = es.string(data);
    es.emit(`console.log(${src});`);
  });
}

function ParseJSON(cs) {
  const inp = cs.input('in', 'text');
  const out = cs.output('out', 'json');
  cs.action([inp], function(es) {
    const in_expr = es.string(inp);
    es.emit(`const ${out.slot} = JSON.parse(${in_expr});`);
    es.emit_triggered(out, '');
  });
}

function EncodeJSON(cs) {
  const inp = cs.input('in', 'json');
  const out = cs.output('out', 'text');
  cs.action([inp], function(es) {
    const in_expr = es.string(inp);
    es.emit(`const ${out.slot} = JSON.stringify(${in_expr});`);
    es.emit_triggered(out, '');
  });
}

function LoadImage(cs) {
  const src = cs.input('src', 'text');
  const elem = cs.output('element', 'DOM:Element:Image');
  const width = cs.output('width', 'number');
  const height = cs.output('height', 'number');
  cs.action([src], function(es) {
    const in_src = es.string(src);
    es.emit(`var ${elem.slot} = new Image;`);
    es.emit(`${elem.slot}.onload = function () {`);
    // want to create a waitable thing that all of these belong to.
    es.emit_triggered(elem, '  ');
    es.emit_triggered(width, '  ');
    es.emit_triggered(height, '  ');
    es.emit(`};`);
    es.emit(`${elem.slot}.src = ${in_src};`);
  });
}

function DOMCanvas(cs) {
  const width = cs.input('width', 'integer', 100);
  const height = cs.input('height', 'integer', 100);
  const autoSize = cs.input('autoSize', 'boolean', false);
  const animate = cs.input('animate', 'boolean', false);
  const canvas = cs.output('element', 'DOM:Element:Canvas');
  const redraw = cs.output('redraw', 'queued');
  const resizeGroup = cs.outputGroup('resized');
  const backingWidth = cs.output('backingWidth', 'integer', resizeGroup);
  const backingHeight = cs.output('backingHeight', 'integer', resizeGroup);
  const drawCmds = cs.listOf('draw', 'Canvas:DrawCmd');
  const cssWidth = cs.uid('cssWidth'), cssHeight = cs.uid('cssHeight');
  const resize = cs.uid('resize'), sizeDirty = cs.uid('sizeDirty');
  cs.on_init(()=>`
    var ${canvas.slot} = document.createElement('canvas');
    document.body.insertBefore(${canvas.slot}, document.body.firstChild);
  `);

  // when autosize is const false.
  // when autosize varies: whenever it becomes false.
  cs.when_false(autoSize).on_each([width,height], ()=>`
    ${canvas.slot}.width = ${width.emit_read()};
    ${canvas.slot}.height = ${height.emit_read()};
    ${canvas.slot}.style.width = (${width.emit_read()})+'px';
    ${canvas.slot}.style.height = (${height.emit_read()})+'px';
    ${resizeGroup.emit_commit()}
  `);

  // Defer resizing the canvas until next frame.
  // This approach avoids flicker in IE (clears canvas on resize)
  // and avoids many extra redraws during Firefox fullscreen transition.
  cs.can_be_true(autoSize).emit(()=>`
    var ${sizeDirty} = true;
    function ${resize}() {
      ${sizeDirty} = true;
      ${redraw.emit_enqueue()}
    }
  `).on_run(redraw, ()=>`
    if (${sizeDirty}) {
      ${sizeDirty} = false;
      var ${cssWidth} = window.innerWidth || (document.documentElement ? document.documentElement.offsetWidth : document.body.offsetWidth);
      var ${cssHeight} = window.innerHeight || (document.documentElement ? document.documentElement.offsetHeight : document.body.offsetHeight);
      ${canvas.slot}.width = ${cssWidth};
      ${canvas.slot}.height = ${cssHeight};
      ${canvas.slot}.style.width = ${cssWidth}+'px';
      ${canvas.slot}.style.height = ${cssHeight}+'px';
      ${resizeGroup.emit_commit()}
    }
  `);

  // when autosize is const true.
  // when autosize varies: whenever it becomes true.
  cs.when_true(autoSize).emit(()=>`
    window.addEventListener('resize', ${resize}, false);
  `);
  cs.on_false_to_true(autoSize).emit(()=>`
    ${sizeDirty} = true;
    ${redraw.emit_enqueue()}
  `);
  cs.on_true_to_false(autoSize).emit(()=>`
    window.removeEventListener('resize', ${resize}, false);
  `);

  // when animate is const true.
  // when animate varies: whenever it becomes true.
  cs.on_run(redraw).when_true(animate, ()=>`
    window.requestAnimationFrame(${redraw.emit_enqueue_funcref()});
  `);
  cs.on_run(redraw).can_be_true(animate, ()=>`
    var dt = ts - (lastTS || ts);
    lastTS = ts;
    if (dt > 50) dt = 50; // 20 fps.
  `);
  cs.when_true(animate, ()=>`
    window.requestAnimationFrame(${redraw.emit_enqueue_funcref()});
  `);
  cs.on_true_to_false(animate).emit(()=>`
    window.cancelAnimationFrame(${redraw.emit_enqueue_funcref()});
  `);

}

function WebGLCanvas(cs) {
  const alpha = cs.input('alpha', 'boolean', false); // default true.
  const depth = cs.input('depth', 'boolean', false); // default true.
  const stencil = cs.input('stencil', 'boolean', false); // default false.
  const antialias = cs.input('antialias', 'boolean', false); // default true.
  const preserveDrawingBuffer = cs.input('preserveDrawingBuffer', 'boolean', false);
  const canvas = cs.output('element', 'DOM:Element:Canvas');
  const glContext = cs.output('context', 'DOM:WebGL:Context.v1');
  const performanceCaveat = cs.output('performanceCaveat', 'signal');
  const noWebGL = cs.output('noWebGL', 'signal');
  const initialized = cs.output('initialized', 'signal');
  const sizeDirty = cs.slot('sizeDirty', 'boolean', false);
  const initWebGL = cs.uid('initWebGL');
  const destWebGL = cs.uid('destWebGL');
  cs.action([], function(es) {
    es.emit(`
var ${sizeDirty.slot} = true;
var ${glContext.slot} = null;
var ${canvas.slot} = document.createElement('canvas');
document.body.insertBefore(${canvas.slot}, document.body.firstChild);

// https://www.khronos.org/webgl/wiki/HandlingContextLost
${canvas.slot}.addEventListener("webglcontextlost", function(event) {
    event.preventDefault();
    ${destWebGL}();
}, false);
${canvas.slot}.addEventListener("webglcontextrestored", ${initWebGL}, false);

window.addEventListener('resize', function() {
  // Defer resizing the canvas until next frame.
  // This approach avoids flicker in IE (clears canvas on resize)
  // and avoids many extra redraws during Firefox fullscreen transition.
  ${sizeDirty.slot} = true;
}, false);

${initWebGL}();

function ${initWebGL}() {
  var glopts = {
    alpha: ${alpha.resolve().asBool()},
    depth: ${depth.resolve().asBool()},
    stencil: ${stencil.resolve().asBool()},
    antialias: ${antialias.resolve().asBool()},
    preserveDrawingBuffer: ${preserveDrawingBuffer.resolve().asBool()},
    failIfMajorPerformanceCaveat: true
  };
  ${glContext.slot} = canvas.getContext("webgl", glopts) || canvas.getContext("experimental-webgl", glopts);
  if (!${glContext.slot}) {
    glopts.failIfMajorPerformanceCaveat = false;
    ${glContext.slot} = canvas.getContext("webgl", glopts) || canvas.getContext("experimental-webgl", glopts);
    if (${glContext.slot}) {
      ${performanceCaveat.resolve().whenTrue()}
    } else {
      ${noWebGL.whenTrue()}
      return;
    }
  }
  ${performanceCaveat.whenFalse()}
  ${noWebGL.whenFalse()}
  sizeViewport();
  ${initialized.whenTrue()}
}

function ${destWebGL}() {
  ${initialized.whenFalse()}
  ${glContext.slot} = null;
}
    `);
  });
}

function CRC(cs) {
  // https://en.wikipedia.org/wiki/Cyclic_redundancy_check
  // width: of the LFSR (3,4,5,6,7,8,10,11,12,13,14,15,16,17,21,24,30,31,32,40,64,82)
  // initial: starting value for the LFSR.
  // polynomial: MSB-first, high-bit omitted, low-bit always set.
  // reflect input: reverse input bits.
  // reflect output: reverse output bits.
  // xor-out: pattern to xor with the result.
  // prefix: bits prepended to the message.
  // byte order: big or little endian.
  // check/residue: values used to verify that the configuration is correct.
  // Presets: crc32/crc32b, http://reveng.sourceforge.net/crc-catalogue/all.htm
}
