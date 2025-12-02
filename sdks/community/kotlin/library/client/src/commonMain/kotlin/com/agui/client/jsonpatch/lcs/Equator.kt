package com.agui.client.jsonpatch.lcs
/*
 * Licensed to the Apache Software Foundation (ASF) under one or more contributor license
 * agreements. See the NOTICE file distributed with this work for additional information regarding
 * copyright ownership. The ASF licenses this file to You under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License. You may obtain a
 * copy of the License at http://www.apache.org/licenses/LICENSE-2.0 Unless required by applicable
 * law or agreed to in writing, software distributed under the License is distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License
 * for the specific language governing permissions and limitations under the License.
 */ /**
 * An equation function, which determines equality between objects of type T.
 *
 *
 * It is the functional sibling of [java.util.Comparator]; [Equator] is to
 * [Object] as [java.util.Comparator] is to [java.lang.Comparable].
 *
 * @param <T> the types of object this [Equator] can evaluate.
 * @since 4.0
 * @version $Id: Equator.java 1540567 2013-11-10 22:19:29Z tn $
</T> */
interface Equator<T> {
    /**
     * Evaluates the two arguments for their equality.
     *
     * @param o1 the first object to be equated.
     * @param o2 the second object to be equated.
     * @return whether the two objects are equal.
     */
    fun equate(o1: T, o2: T): Boolean

    /**
     * Calculates the hash for the object, based on the method of equality used in the equate
     * method. This is used for classes that delegate their [equals(Object)][Object.equals] method to an
     * Equator (and so must also delegate their [hashCode()][Object.hashCode] method), or for implementations
     * of  org.apache.commons.collections4.map.HashedMap that use an Equator for the key objects.
     *
     * @param o the object to calculate the hash for.
     * @return the hash of the object.
     */
    fun hash(o: T): Int
}