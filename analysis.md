# Feature: Formal and LLM-based verification of compiled DML

Goal: To run a formal analysis on compiled DML code:
1. use static analysis to identify tainted sources and sinks
2. use static analysis to identify potentially tainted memory (as tracked in meta interpreter

    Example: system ,user, task, prompt predicates
        - output comes from LLM, tainted if memory or prompt used contains external data

    External data
        - user input
        - external tool output

3. not all cases maybe identified, need to run an llm analysis on the compiled code (which can be prompt injected, how to solve?) to identify other issues

Modify compile step to add an analysis along the lines of the above. produce a list of warnings and suggestions for how to fix this


Pre-req: Tools need to be marked as tainted if they have certain capabilities, propose capabilities system design

Secuirty rules may be defined in .deepclause/some_dml_knowledgebase.dml --> explore how to define rules and apply them during compile and run