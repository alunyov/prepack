/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import {
  AbstractValue,
  ECMAScriptSourceFunctionValue,
  EmptyValue,
  FunctionValue,
  IntegralValue,
  ObjectValue,
  SymbolValue,
} from "../values/index.js";
import type { Effects, Realm, SideEffectType } from "../realm.js";

import { FatalError } from "../errors.js";
import type { PropertyBinding, Descriptor } from "../types.js";
import invariant from "../invariant.js";
import { IsArray, IsArrayIndex } from "../methods/index.js";
import { Logger } from "../utils/logger.js";
import { Generator } from "../utils/generator.js";
import type { AdditionalFunctionEffects } from "./types";
import type { Binding } from "../environment.js";
import type { BabelNodeSourceLocation } from "@babel/types";
import { optionalStringOfLocation } from "../utils/babelhelpers.js";
import { PropertyDescriptor } from "../descriptors.js";
import { GeneratorDAG } from "./GeneratorDAG";
import type { Scope } from "./types.js";
import { FunctionEnvironmentRecord } from "../environment";
import type { Value } from "../values/index";
import type { AdditionalFunctionEffectsVariantArgs } from "./types";

/**
 * Get index property list length by searching array properties list for the max index key value plus 1.
 * If tail elements are conditional, return the minimum length if an assignment to the length property
 * can be avoided because of that. The boolean part of the result is a flag that indicates if the latter is true.
 */
export function getSuggestedArrayLiteralLength(realm: Realm, val: ObjectValue): [number, boolean] {
  invariant(IsArray(realm, val));
  let instantRenderMode = realm.instantRender.enabled;
  let minLength = 0,
    maxLength = 0;
  let actualLength;
  for (const key of val.properties.keys()) {
    if (IsArrayIndex(realm, key) && Number(key) >= maxLength) {
      let prevMax = maxLength;
      maxLength = Number(key) + 1;
      let elem = val._SafeGetDataPropertyValue(key);
      if (instantRenderMode || !elem.mightHaveBeenDeleted()) minLength = maxLength;
      else if (elem instanceof AbstractValue && elem.kind === "conditional") {
        let maxLengthVal = new IntegralValue(realm, maxLength);
        let [c, x, y] = elem.args;
        if (x instanceof EmptyValue && !y.mightHaveBeenDeleted()) {
          let prevActual = actualLength === undefined ? new IntegralValue(realm, prevMax) : actualLength;
          actualLength = AbstractValue.createFromConditionalOp(realm, c, prevActual, maxLengthVal);
        } else if (y instanceof EmptyValue && !x.mightHaveBeenDeleted()) {
          let prevActual = actualLength === undefined ? new IntegralValue(realm, prevMax) : actualLength;
          actualLength = AbstractValue.createFromConditionalOp(realm, c, maxLengthVal, prevActual);
        } else {
          actualLength = undefined;
        }
      }
    }
  }
  if (maxLength > minLength && actualLength instanceof AbstractValue) {
    let lengthVal = val._SafeGetDataPropertyValue("length");
    if (lengthVal.equals(actualLength)) return [minLength, true];
  }
  return [maxLength, false];
}

export function commonAncestorOf<T>(node1: void | T, node2: void | T, getParent: T => void | T): void | T {
  if (node1 === node2) return node1;
  // First get the path length to the root node for both nodes while also checking if
  // either node is the parent of the other.
  let n1 = node1,
    n2 = node2,
    count1 = 0,
    count2 = 0;
  while (true) {
    let p1 = n1 && getParent(n1);
    let p2 = n2 && getParent(n2);
    if (p1 === node2) return node2;
    if (p2 === node1) return node1;
    if (p1 !== undefined) count1++;
    if (p2 !== undefined) count2++;
    if (p1 === undefined && p2 === undefined) break;
    n1 = p1;
    n2 = p2;
  }
  // Now shorten the longest path to the same length as the shorter path
  n1 = node1;
  while (count1 > count2) {
    invariant(n1 !== undefined);
    n1 = getParent(n1);
    count1--;
  }
  n2 = node2;
  while (count1 < count2) {
    invariant(n2 !== undefined);
    n2 = getParent(n2);
    count2--;
  }
  // Now run up both paths in tandem, stopping at the first common entry
  while (n1 !== n2) {
    invariant(n1 !== undefined);
    n1 = getParent(n1);
    invariant(n2 !== undefined);
    n2 = getParent(n2);
  }
  return n1;
}

// Gets map[key] with default value provided by defaultFn
export function getOrDefault<K, V>(map: Map<K, V>, key: K, defaultFn: () => V): V {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = defaultFn()));
  invariant(value !== undefined);
  return value;
}

export function withDescriptorValue(
  propertyNameOrSymbol: string | SymbolValue,
  descriptor: void | Descriptor,
  func: Function
): void {
  if (descriptor !== undefined) {
    invariant(descriptor instanceof PropertyDescriptor); // TODO: Handle joined descriptors.
    if (descriptor.value !== undefined) {
      func(propertyNameOrSymbol, descriptor.value, "value");
    } else {
      if (descriptor.get !== undefined) {
        func(propertyNameOrSymbol, descriptor.get, "get");
      }
      if (descriptor.set !== undefined) {
        func(propertyNameOrSymbol, descriptor.set, "set");
      }
    }
  }
}

export const ClassPropertiesToIgnore: Set<string> = new Set(["arguments", "name", "caller"]);

export function canIgnoreClassLengthProperty(val: ObjectValue, desc: void | Descriptor, logger: Logger): boolean {
  if (desc) {
    if (desc instanceof PropertyDescriptor) {
      if (desc.value === undefined) {
        logger.logError(val, "Functions with length accessor properties are not supported in residual heap.");
      }
    } else {
      logger.logError(
        val,
        "Functions with length properties with different attributes are not supported in residual heap."
      );
    }
  }
  return true;
}

export function getObjectPrototypeMetadata(
  realm: Realm,
  obj: ObjectValue
): { skipPrototype: boolean, constructor: void | ECMAScriptSourceFunctionValue } {
  let proto = obj.$Prototype;
  let skipPrototype = false;
  let constructor;

  if (obj.$IsClassPrototype) {
    skipPrototype = true;
  }
  if (proto && proto.$IsClassPrototype) {
    invariant(proto instanceof ObjectValue);
    // we now need to check if the prototpe has a constructor
    let _constructor = proto.properties.get("constructor");
    if (_constructor !== undefined) {
      // if the contructor has been deleted then we have no way
      // to serialize the original class AST as it won't have been
      // evluated and thus visited
      if (_constructor.descriptor === undefined) {
        throw new FatalError("TODO #1024: implement object prototype serialization with deleted constructor");
      }
      if (!(_constructor.descriptor instanceof PropertyDescriptor)) {
        throw new FatalError(
          "TODO #1024: implement object prototype serialization with multiple constructor attributes"
        );
      }
      let classFunc = _constructor.descriptor.value;
      if (classFunc instanceof ECMAScriptSourceFunctionValue) {
        constructor = classFunc;
        skipPrototype = true;
      }
    }
  }

  return {
    skipPrototype,
    constructor,
  };
}

export function createAdditionalEffects(
  realm: Realm,
  effects: Effects,
  fatalOnAbrupt: boolean,
  name: string,
  additionalFunctionEffects: Map<FunctionValue, AdditionalFunctionEffects>,
  // These are for forming a proper parent chain for optimized functions
  variantArgs: AdditionalFunctionEffectsVariantArgs
): AdditionalFunctionEffects | null {
  let generator = Generator.fromEffects(effects, realm, name, additionalFunctionEffects, variantArgs);
  let retValue: AdditionalFunctionEffects = {
    parentAdditionalFunction: variantArgs.parentOptimizedFunction || undefined,
    effects,
    transforms: [],
    generator,
    additionalRoots: new Set(),
  };
  return retValue;
}

export function handleReportedSideEffect(
  exceptionHandler: (string, ?BabelNodeSourceLocation) => void,
  sideEffectType: SideEffectType,
  binding: void | Binding | PropertyBinding,
  expressionLocation: ?BabelNodeSourceLocation
): void {
  // This causes an infinite recursion because creating a callstack causes internal-only side effects
  if (binding && binding.object && binding.object.intrinsicName === "__checkedBindings") return;
  let location = optionalStringOfLocation(expressionLocation);

  if (sideEffectType === "MODIFIED_BINDING") {
    let name = binding ? `"${((binding: any): Binding).name}"` : "unknown";
    exceptionHandler(`side-effects from mutating the binding ${name}${location}`, expressionLocation);
  } else if (sideEffectType === "MODIFIED_PROPERTY" || sideEffectType === "MODIFIED_GLOBAL") {
    let name = "";
    let pb = ((binding: any): PropertyBinding);
    let key = pb.key;
    if (typeof key === "string") {
      name = `"${key}"`;
    }
    if (sideEffectType === "MODIFIED_PROPERTY") {
      if (!ObjectValue.refuseSerializationOnPropertyBinding(pb))
        exceptionHandler(`side-effects from mutating a property ${name}${location}`, expressionLocation);
    } else {
      exceptionHandler(`side-effects from mutating the global object property ${name}${location}`, expressionLocation);
    }
  } else if (sideEffectType === "EXCEPTION_THROWN") {
    exceptionHandler(`side-effects from throwing exception${location}`, expressionLocation);
  }
}

export class ResidualOptimizedFunctions {
  constructor(
    generatorDAG: GeneratorDAG,
    optimizedFunctionsAndEffects: Map<FunctionValue, AdditionalFunctionEffects>,
    residualValues: Map<Value, Set<Scope>>
  ) {
    this._generatorDAG = generatorDAG;
    this._optimizedFunctionsAndEffects = optimizedFunctionsAndEffects;
    this._residualValues = residualValues;
  }

  _generatorDAG: GeneratorDAG;
  _optimizedFunctionsAndEffects: Map<FunctionValue, AdditionalFunctionEffects>;
  _residualValues: Map<Value, Set<Scope>>;

  _isDefinedInsideFunction(childFunction: FunctionValue, maybeParentFunctions: Set<FunctionValue>): boolean {
    for (let maybeParentFunction of maybeParentFunctions) {
      if (childFunction === maybeParentFunction) {
        continue;
      }
      // for optimized functions, we should use created objects
      let maybeParentFunctionInfo = this._optimizedFunctionsAndEffects.get(maybeParentFunction);
      if (maybeParentFunctionInfo && maybeParentFunctionInfo.effects.createdObjects.has(childFunction)) return true;
      else {
        // for other functions, check environment records
        let env = childFunction.$Environment;
        while (env.parent !== null) {
          let envRecord = env.environmentRecord;
          if (envRecord instanceof FunctionEnvironmentRecord && envRecord.$FunctionObject === maybeParentFunction)
            return true;
          env = env.parent;
        }
      }
    }
    return false;
  }

  // Check if an optimized function defines the given set of functions.
  _definesFunctions(possibleParentFunction: FunctionValue, functions: Set<FunctionValue>): boolean {
    let maybeParentFunctionInfo = this._optimizedFunctionsAndEffects.get(possibleParentFunction);
    invariant(maybeParentFunctionInfo);
    let createdObjects = maybeParentFunctionInfo.effects.createdObjects;
    for (let func of functions) if (func !== possibleParentFunction && !createdObjects.has(func)) return false;
    return true;
  }

  // Try and get the root optimized function when passed in an optimized function
  // that may or may not be nested in the tree of said root, or is the root optimized function
  tryGetOptimizedFunctionRoot(val: Value): void | FunctionValue {
    let scopes = this._residualValues.get(val);
    invariant(scopes !== undefined);
    return this.tryGetOutermostOptimizedFunction(scopes);
  }

  // Try and get the optimized function that contains all the scopes passed in (may be one of the
  // scopes passed in)
  tryGetOutermostOptimizedFunction(scopes: Set<Scope>): void | FunctionValue {
    let functionValues = new Set();
    invariant(scopes !== undefined);
    for (let scope of scopes) {
      let s = scope;
      while (s instanceof Generator) {
        s = this._generatorDAG.getParent(s);
      }
      if (s === "GLOBAL") return undefined;
      invariant(s instanceof FunctionValue);
      functionValues.add(s);
    }
    let outermostAdditionalFunctions = new Set();

    // Get the set of optimized functions that may be the root

    for (let functionValue of functionValues) {
      if (this._optimizedFunctionsAndEffects.has(functionValue)) {
        if (!this._isDefinedInsideFunction(functionValue, functionValues))
          outermostAdditionalFunctions.add(functionValue);
      } else {
        let f = this.tryGetOptimizedFunctionRoot(functionValue);
        if (f === undefined) return undefined;
        if (!this._isDefinedInsideFunction(f, functionValues)) outermostAdditionalFunctions.add(f);
      }
    }
    if (outermostAdditionalFunctions.size === 1) return [...outermostAdditionalFunctions][0];

    // See if any of the outermost (or any of their parents) are the outermost optimized function
    let possibleRoots = [...outermostAdditionalFunctions];
    while (possibleRoots.length > 0) {
      let possibleRoot = possibleRoots.shift();
      if (this._definesFunctions(possibleRoot, outermostAdditionalFunctions)) return possibleRoot;
      let additionalFunctionEffects = this._optimizedFunctionsAndEffects.get(possibleRoot);
      invariant(additionalFunctionEffects);
      let parent = additionalFunctionEffects.parentAdditionalFunction;
      if (parent) possibleRoots.push(parent);
    }
    return undefined;
  }
}
