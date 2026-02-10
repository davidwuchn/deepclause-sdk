
import { analyzeDML } from '../src/compiler.js';
import { loadProlog } from '../src/prolog/loader.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('DML Static Analysis', () => {
  beforeAll(async () => {
    await loadProlog();
  });

  it('should detect tainted data flow and dangerous tools', async () => {
    const dml = readFileSync(join(process.cwd(), 'tests/fixtures/analysis_test.dml'), 'utf-8');
    
    const result = await analyzeDML(dml);
    
    console.log('Analysis Result:', JSON.stringify(result, null, 2));

    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);

    const warningMessages = result.warnings.map(w => w.message);
    
    // Check for specific warnings
    expect(warningMessages.some(m => m.includes('Usage of dangerous tool detected'))).toBe(true);
    expect(warningMessages.some(m => m.includes('Avoid using format() directly inside answer'))).toBe(true);
    
    // Taint analysis checks (if implemented correctly in Prolog)
    expect(warningMessages.some(m => m.includes('Taint: parameter flows into system prompt'))).toBe(true);
    expect(warningMessages.some(m => m.includes('Security Risk: parameter flows into external tool execution'))).toBe(true);
  });

  it('should track taint across multiple hops', async () => {
    const dml = readFileSync(join(process.cwd(), 'tests/fixtures/multi_hop_taint.dml'), 'utf-8');
    const result = await analyzeDML(dml);
    
    console.log('Multi-hop Analysis Result:', JSON.stringify(result, null, 2));

    expect(result.valid).toBe(true);
    const warnings = result.warnings;
    
    // Should detect taint from tool argument 'Input' to 'exec'
    expect(warnings.some(w => 
      w.level === 'critical' && 
      w.message.includes('tool argument') && 
      w.message.includes('process_data')
    )).toBe(true);

    // Should detect taint from agent argument 'UserInput' to 'exec'
    expect(warnings.some(w => 
      w.level === 'critical' && 
      w.message.includes('agent argument') && 
      w.message.includes('agent_main')
    )).toBe(true);

    // Should detect taint from parameter 'api_key' to 'exec'
    expect(warnings.some(w => 
      w.level === 'critical' && 
      w.message.includes('parameter') && 
      w.message.includes('agent_main')
    )).toBe(true);
  });

  it('should detect taint from param/3', async () => {
    const dml = readFileSync(join(process.cwd(), 'tests/fixtures/param_taint_test.dml'), 'utf-8');
    const result = await analyzeDML(dml);
    
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => 
      (w.message.includes('Taint') || w.message.includes('Security Risk')) && 
      w.message.includes('parameter')
    )).toBe(true);
  });

  it('should detect implicit taint flow into task via memory', async () => {
    const dml = readFileSync(join(process.cwd(), 'tests/fixtures/implicit_taint_test.dml'), 'utf-8');
    const result = await analyzeDML(dml);
    
    console.log('Implicit Taint Analysis Result:', JSON.stringify(result, null, 2));

    expect(result.valid).toBe(true);
    const warnings = result.warnings;

    // Should detect taint from 'Name' or 'ID' (parameters) flowing into system then task
    expect(warnings.some(w => 
      w.level === 'medium' && 
      w.message.includes('implicitly inherits memory') && 
      w.message.includes('parameter')
    )).toBe(true);

    // Should detect taint from 'UserMsg' (user input) flowing into user() then task
    expect(warnings.some(w => 
      w.level === 'medium' && 
      w.message.includes('implicitly inherits memory') && 
      w.message.includes('user input')
    )).toBe(true);
  });
});
