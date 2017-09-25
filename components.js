"use strict";

module.exports = {
  ReadText,
  WriteText,
  ParseJSON,
  EncodeJSON,
};

function ReadText(cs) {
  const fs = cs.imports('fs');
  const filename = cs.input('filename', 'text');
  const data = cs.output('out', 'text');
  cs.action([filename], function(es) {
    const name = es.string(filename);
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
